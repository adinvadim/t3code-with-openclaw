#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This release boundary exercises synchronous Git and filesystem inode operations without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const Note = Schema.Struct({ path: Schema.String, digest: Schema.String, body: Schema.String });
const Snapshot = Schema.Struct({
  target: Schema.String,
  previousTag: Schema.String,
  notes: Schema.Array(Note),
});
type Snapshot = typeof Snapshot.Type;

function git(root: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}
function digest(body: string) {
  return NodeCrypto.createHash("sha256").update(body).digest("hex");
}
export function parseFragment(path: string, contents: string) {
  const match = /^## Changes\r?\n([\s\S]*)$/.exec(contents.trim());
  if (!match) throw new Error(`${path}: expected ## Changes with English Markdown bullets`);
  const body = match[1]?.trim();
  if (!body || body.split(/\r?\n/).some((line) => line !== "" && !line.startsWith("- "))) {
    throw new Error(`${path}: expected nonempty one-line Markdown bullets`);
  }
  return body;
}
function isFragment(path: string) {
  return /^\.changes\/[^/]+\.md$/.test(path) && path !== ".changes/README.md";
}

export function collectFragments(root: string, target: string, previousTag: string): Snapshot {
  const frozen = git(root, ["rev-parse", "--verify", `${target}^{commit}`]).trim();
  const previous = previousTag
    ? git(root, ["rev-parse", "--verify", `${previousTag}^{commit}`]).trim()
    : "";
  if (previous) git(root, ["merge-base", "--is-ancestor", previous, frozen]);
  const range = previous ? `${previous}..${frozen}` : frozen;
  const revisions = git(root, [
    "rev-list",
    "--full-history",
    "--topo-order",
    range,
    "--",
    ".changes",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  const candidates = new Set<string>();
  for (const revision of revisions) {
    const paths = git(root, [
      "diff-tree",
      "--root",
      "--diff-merges=first-parent",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=AM",
      "-r",
      "-z",
      revision,
      "--",
      ".changes",
    ])
      .split("\0")
      .filter(isFragment);
    for (const path of paths) candidates.add(path);
  }
  const notes: Snapshot["notes"][number][] = [];
  for (const path of candidates) {
    let source = frozen;
    const present = git(root, ["ls-tree", "--name-only", frozen, "--", path]).trim() !== "";
    if (!present) {
      const cleanup = git(root, ["log", "-1", "--format=%H", frozen, "--", path]).trim();
      if (!cleanup) continue;
      const lastSubject = git(root, ["show", "-s", "--format=%s", cleanup]).trim();
      if (!lastSubject.startsWith("chore(release): prepare ")) continue;
      source = `${cleanup}^`;
    }
    // Resolve merge corrections from the frozen tree; parse only surviving candidates.
    const contents = git(root, ["show", `${source}:${path}`]);
    notes.push({ path, digest: digest(contents), body: parseFragment(path, contents) });
  }
  return {
    target: frozen,
    previousTag: previous,
    notes: notes.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

export function renderFragments(snapshot: Snapshot) {
  return snapshot.notes.length
    ? `## Changes\n\n${snapshot.notes.map((note) => note.body).join("\n")}\n`
    : "";
}

export function finalizeFragments(root: string, tag: string, snapshot: Snapshot) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag))
    throw new Error("Invalid release tag");
  for (const note of snapshot.notes)
    if (!isFragment(note.path)) throw new Error("Invalid fragment path in snapshot");
  const changelogPath = NodePath.join(root, "CHANGELOG.md");
  const current = NodeFS.existsSync(changelogPath)
    ? NodeFS.readFileSync(changelogPath, "utf8")
    : "# Changelog\n";
  const marker = `<!-- release-fragments:${tag}:${snapshot.target} -->`;
  const body = renderFragments(snapshot) || "No user-visible changes.\n";
  const section = `\n## ${tag}\n\n${marker}\n\n${body.replace(/^## Changes\n\n/, "")}`;
  if (current.includes(marker)) {
    const existing = current.slice(current.indexOf(`\n## ${tag}\n`) + 1).split(/\n## /, 1)[0];
    if (existing?.trim() !== section.trim())
      throw new Error("Release section does not match its complete snapshot");
  } else {
    if (current.includes(`\n## ${tag}\n`))
      throw new Error("Release section exists with a different source");
    const header = current.indexOf("\n");
    const result =
      header < 0
        ? `${current}\n${section}`
        : `${current.slice(0, header + 1)}${section}${current.slice(header + 1)}`;
    const temporary = NodePath.join(root, `.release-changelog-${NodeCrypto.randomUUID()}`);
    NodeFS.writeFileSync(temporary, result);
    NodeFS.renameSync(temporary, changelogPath);
  }
  // Finalize runs in a clean workflow checkout. Preserve a recovery inode for racing open writers.
  const recovery = NodePath.join(root, ".changes", ".recovery");
  NodeFS.mkdirSync(recovery, { recursive: true });
  for (const note of snapshot.notes) {
    const path = NodePath.join(root, note.path);
    if (!NodeFS.existsSync(path) || digest(NodeFS.readFileSync(path, "utf8")) !== note.digest)
      continue;
    const backup = NodePath.join(recovery, `${NodeCrypto.randomUUID()}.md`);
    NodeFS.renameSync(path, backup);
    if (digest(NodeFS.readFileSync(backup, "utf8")) !== note.digest) {
      try {
        NodeFS.linkSync(backup, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      process.stderr.write(`Concurrent fragment preserved; recovery copy: ${backup}\n`);
    }
  }
}

if (import.meta.main) {
  try {
    const [command, first, second, third, fourth] = process.argv.slice(2);
    if (command === "build" && first && second !== undefined && third && fourth) {
      const snapshot = collectFragments(process.cwd(), first, second);
      NodeFS.writeFileSync(third, renderFragments(snapshot));
      NodeFS.writeFileSync(fourth, `${JSON.stringify(snapshot, null, 2)}\n`);
    } else if (command === "finalize" && first && second) {
      const snapshot = Schema.decodeUnknownSync(Snapshot)(
        JSON.parse(NodeFS.readFileSync(second, "utf8")),
      );
      finalizeFragments(process.cwd(), first, snapshot);
    } else {
      throw new Error(
        "usage: release-fragments.ts build TARGET PREVIOUS_TAG NOTES_FILE SNAPSHOT_FILE | finalize TAG SNAPSHOT_FILE",
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

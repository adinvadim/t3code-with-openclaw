// @effect-diagnostics nodeBuiltinImport:off - This release boundary exercises synchronous Git and filesystem inode operations without an Effect runtime.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Yaml from "yaml";
import {
  collectFragments,
  finalizeFragments,
  parseFragment,
  renderFragments,
} from "./release-fragments.ts";

const decodeWorkflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      check_changes: Schema.Struct({
        steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })),
      }),
    }),
  }),
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function write(root: string, path: string, value: string) {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), value);
}
function commit(root: string, title: string) {
  git(root, "add", ".");
  git(root, "commit", "-qm", title);
  return git(root, "rev-parse", "HEAD");
}
function repo() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-fragments-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Release Test");
  git(root, "config", "user.email", "test@example.invalid");
  write(root, "initial", "initial\n");
  commit(root, "initial");
  git(root, "tag", "v1.0.0");
  return root;
}

describe("release fragment lifecycle", () => {
  it("pins committed notes and preserves new and changed working files", () => {
    const root = repo();
    write(root, ".changes/one.md", "## Changes\n\n- One.\n");
    const target = commit(root, "feat: one");
    write(root, ".changes/one.md", "## Changes\n\n- Newer edit.\n");
    write(root, ".changes/two.md", "## Changes\n\n- Two.\n");
    const snapshot = collectFragments(root, target, "v1.0.0");
    expect(renderFragments(snapshot)).toBe("## Changes\n\n- One.\n");
    finalizeFragments(root, "v1.1.0", snapshot);
    expect(NodeFS.readFileSync(NodePath.join(root, ".changes/one.md"), "utf8")).toContain(
      "Newer edit",
    );
    expect(NodeFS.existsSync(NodePath.join(root, ".changes/two.md"))).toBe(true);
  });
  it("keeps stable and nightly independent across stable cleanup", () => {
    const root = repo();
    git(root, "tag", "v1.1.0-nightly.20261018.1");
    write(root, ".changes/one.md", "## Changes\n\n- One.\n");
    const target = commit(root, "feat: one");
    git(root, "tag", "v1.1.0");
    const stable = collectFragments(root, target, "v1.0.0");
    finalizeFragments(root, "v1.1.0", stable);
    commit(root, "chore(release): prepare v1.1.0");
    expect(NodeFS.existsSync(NodePath.join(root, ".changes/one.md"))).toBe(false);
    const nightly = collectFragments(root, "HEAD", "v1.1.0-nightly.20261018.1");
    expect(renderFragments(nightly)).toContain("- One.");
    git(root, "tag", "v1.2.0-nightly.20261019.1");
    expect(collectFragments(root, "HEAD", "v1.2.0-nightly.20261019.1").notes).toHaveLength(0);
    expect(collectFragments(root, "HEAD", "v1.1.0").notes).toHaveLength(0);
  });
  it("retries without duplicate sections and cleans only original identities", () => {
    const root = repo();
    write(root, ".changes/one.md", "## Changes\n\n- One.\n");
    commit(root, "feat: one");
    const snapshot = collectFragments(root, "HEAD", "v1.0.0");
    finalizeFragments(root, "v1.1.0", snapshot);
    write(root, ".changes/one.md", "## Changes\n\n- One.\n");
    finalizeFragments(root, "v1.1.0", snapshot);
    expect(NodeFS.existsSync(NodePath.join(root, ".changes/one.md"))).toBe(false);
    const text = NodeFS.readFileSync(NodePath.join(root, "CHANGELOG.md"), "utf8");
    expect(text.match(/## v1.1.0/g)).toHaveLength(1);
    write(root, ".changes/one.md", "## Changes\n\n- Future.\n");
    finalizeFragments(root, "v1.1.0", snapshot);
    expect(NodeFS.readFileSync(NodePath.join(root, ".changes/one.md"), "utf8")).toContain("Future");
  });
  it("skips README, handles an empty first release, and rejects malformed notes", () => {
    const root = repo();
    write(root, ".changes/README.md", "Instructions, not notes");
    commit(root, "docs: instructions");
    expect(renderFragments(collectFragments(root, "HEAD", ""))).toBe("");
    expect(() => parseFragment(".changes/bad.md", "## Changes\n\nparagraph")).toThrow("bullets");
    write(root, ".changes/bad.md", "bad");
    commit(root, "invalid fixture");
    expect(() => collectFragments(root, "HEAD", "v1.0.0")).toThrow("expected ## Changes");
  });
});

it("excludes a fragment removed by reverting its feature", () => {
  const root = repo();
  write(root, ".changes/reverted.md", "## Changes\n\n- Reverted.\n");
  commit(root, "feat: temporary");
  git(root, "rm", ".changes/reverted.md");
  commit(root, "revert: temporary feature");
  expect(collectFragments(root, "HEAD", "v1.0.0").notes).toHaveLength(0);
});

it("refuses cleanup when a previously generated section is incomplete", () => {
  const root = repo();
  write(root, ".changes/one.md", "## Changes\n\n- One.\n");
  commit(root, "feat: one");
  const snapshot = collectFragments(root, "HEAD", "v1.0.0");
  finalizeFragments(root, "v1.1.0", snapshot);
  write(root, ".changes/one.md", "## Changes\n\n- One.\n");
  const text = NodeFS.readFileSync(NodePath.join(root, "CHANGELOG.md"), "utf8").replace(
    "- One.\n",
    "",
  );
  write(root, "CHANGELOG.md", text);
  expect(() => finalizeFragments(root, "v1.1.0", snapshot)).toThrow("complete snapshot");
  expect(NodeFS.existsSync(NodePath.join(root, ".changes/one.md"))).toBe(true);
});

it("the actual scheduled planner ignores notes bookkeeping but sees feature changes", () => {
  const workflow = decodeWorkflow(
    Yaml.parse(
      NodeFS.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    ),
  );
  const script = workflow.jobs.check_changes.steps.find((step) =>
    step.run?.includes("last_nightly_tag="),
  )?.run;
  if (!script) throw new Error("Missing actual scheduled release planner");
  const root = repo();
  git(root, "tag", "v1.1.0-nightly.20261018.1");
  write(root, "CHANGELOG.md", "# Changelog\n");
  commit(root, "chore(release): prepare v1.1.0");
  const output = NodePath.join(root, ".git", "test-github-output");
  NodeChildProcess.execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  expect(NodeFS.readFileSync(output, "utf8")).toContain("has_changes=false");
  write(root, "feature", "new feature\n");
  commit(root, "feat: feature");
  NodeFS.writeFileSync(output, "");
  NodeChildProcess.execFileSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  expect(NodeFS.readFileSync(output, "utf8")).toContain("has_changes=true");
});

it("reads merge-only notes and resolved contents from the frozen merge tree", () => {
  const root = repo();
  const baseBranch = git(root, "branch", "--show-current");
  git(root, "switch", "-qc", "feature");
  write(root, ".changes/branch.md", "## Changes\n\n- Before merge resolution.\n");
  commit(root, "feat: branch");
  git(root, "switch", "-q", baseBranch);
  write(root, "other", "other\n");
  commit(root, "feat: other");
  git(root, "merge", "--no-commit", "--no-ff", "feature");
  write(root, ".changes/branch.md", "## Changes\n\n- Resolved in merge.\n");
  write(root, ".changes/merge-only.md", "## Changes\n\n- Added only in merge.\n");
  commit(root, "Merge feature");
  const body = renderFragments(collectFragments(root, "HEAD", "v1.0.0"));
  expect(body).toContain("Resolved in merge");
  expect(body).toContain("Added only in merge");
  expect(body).not.toContain("Before merge");
});

it("does not parse a malformed note reverted before release", () => {
  const root = repo();
  write(root, ".changes/bad.md", "invalid note\n");
  commit(root, "feat: invalid temporary note");
  git(root, "rm", ".changes/bad.md");
  commit(root, "revert: temporary feature");
  expect(collectFragments(root, "HEAD", "v1.0.0").notes).toHaveLength(0);
});

it("recovers the resolved pre-cleanup blob rather than a discarded side-branch edit", () => {
  const root = repo();
  git(root, "tag", "v1.1.0-nightly.20261018.1");
  write(root, ".changes/one.md", "## Changes\n\n- Surviving wording.\n");
  commit(root, "feat: note");
  const baseBranch = git(root, "branch", "--show-current");
  git(root, "switch", "-qc", "discarded-note");
  write(root, ".changes/one.md", "malformed discarded wording\n");
  commit(root, "feat: discarded note edit");
  git(root, "switch", "-q", baseBranch);
  write(root, "other", "other\n");
  commit(root, "feat: unrelated");
  git(
    root,
    "merge",
    "--no-ff",
    "-s",
    "ours",
    "discarded-note",
    "-m",
    "Merge keeping first-parent wording",
  );
  const stable = collectFragments(root, "HEAD", "v1.0.0");
  expect(renderFragments(stable)).toContain("Surviving wording");
  finalizeFragments(root, "v1.1.0", stable);
  commit(root, "chore(release): prepare v1.1.0");
  const nightly = collectFragments(root, "HEAD", "v1.1.0-nightly.20261018.1");
  expect(renderFragments(nightly)).toContain("Surviving wording");
});

it("ignores a fragment introduced only on a discarded side branch", () => {
  const root = repo();
  const baseBranch = git(root, "branch", "--show-current");
  git(root, "switch", "-qc", "discarded-only");
  write(root, ".changes/discarded.md", "malformed discarded note\n");
  commit(root, "feat: discarded-only note");
  git(root, "switch", "-q", baseBranch);
  write(root, "other", "other\n");
  commit(root, "feat: main");
  git(
    root,
    "merge",
    "--no-ff",
    "-s",
    "ours",
    "discarded-only",
    "-m",
    "Merge without side-branch feature",
  );
  expect(collectFragments(root, "HEAD", "v1.0.0").notes).toHaveLength(0);
});

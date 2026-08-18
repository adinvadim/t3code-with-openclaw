# OpenClaw driver (this fork)

> For maintainers. Using T3 Code? See [OpenClaw](../user/providers-openclaw.md).

This tree adds a sixth provider, `openclaw`. It is an overlay on `pingdotgg/t3code`, not a second
product. Decisions below are the v1 contract. User-visible behavior is documented in the
[user guide](../user/providers-openclaw.md).

## Shape

T3 stays the control surface. OpenClaw stays the runtime.

- New Thread is unchanged. The sidebar lists only T3-created threads. Gateway / Telegram / Home
  sessions are not imported.
- Composer extras: **agent**, **model**, **thinking**. Agent is `modelSelection.options[{ id: "agent" }]`,
  the same slot Claude uses for `effort`. `TraitsPicker` already special-cases `id === "agent"`.
- After first send, agent is frozen: the descriptor stays but lists only the current agent.
  Thinking is the **first** select so T3 does not treat agent as effort.
- Default agent is Gateway `agents.list.defaultId`, else the first selectable agent. Draft model and
  thinking come from that agent, then `DEFAULT_MODEL_BY_PROVIDER`.
- `startSession` **ignores** T3 project / worktree `cwd`. `ProviderSession.cwd` is the agent
  workspace. Checkpoints follow that cwd and no-op when it is not git.
- One T3 thread = one isolated Gateway session `agent:<agentId>:t3:<t3ThreadId>`, labeled T3.
  Never attach to `agent:<id>:main`. `stopSession` aborts and unsubscribes; it does not delete the
  Gateway row.

## Transport

- Attach to a Gateway that is already running. Do not spawn or embed one.
- Own Effect client in `apps/server/src/provider/openclaw/`. Do not depend on
  `@openclaw/gateway-client` / `@openclaw/gateway-protocol` until those packages are real.
- Protocol **v4 only**. Client name `t3-code`. One operator WebSocket per instance; threads
  subscribe on it.
- Pairing: Ed25519 + `connect.challenge`, scopes `operator.read`, `operator.write`,
  `operator.approvals`, `operator.questions`. Bootstrap token (settings, or same-host loopback file)
  only to file the request. Standing credential is `deviceToken` in `ServerSecretStore` for **this
  T3 home**. A worktree is a new device.
- Pairing-required is `auth.status: "unauthenticated"` plus the request id in `message`. Do not add
  a new auth enum.
- Seeded URL: `ws://127.0.0.1:18789`. Do not parse `openclaw.json` for the port.
- Catalog poll: `agents.list` + `models.list` with `preparedOnly`, via `makeManagedServerProvider`.
- Live model / thinking: `sessions.patch`. No Gateway `queueMode`. Mid-turn socket drop fails the
  T3 turn; the next send resumes the same key. No in-turn `deltaCursor` catch-up.
- Map `session.approval` / `exec.approval` to T3 approvals, and Gateway questions to
  `thread.user-input`. Do not auto-allow.
- Composer images pass through within Gateway attachment policy. No T3 MCP injection. Empty
  `slashCommands` / `skills`. `showInteractionModeToggle: false`. Ignore T3 `runtimeMode`.
- `textGeneration` is a required stub. Do not add `openclaw` to `TextGenerationProvider`.

## Layout (keep nightly merges boring)

Thin entries, same lookup habit as other drivers:

- `apps/server/src/provider/Drivers/OpenClawDriver.ts`
- `apps/server/src/provider/Layers/OpenClawAdapter.ts` (and a small snapshot helper if needed)

Fat code (Gateway client, pairing, event projection, fixtures) lives under
`apps/server/src/provider/openclaw/`.

Settings schema: `packages/contracts/src/openclawSettings.ts`, exported from the contracts barrel.
Do **not** add `openclaw` to the legacy `ServerSettings.providers` five. Instances live only in
`providerInstances`. `supportsMultipleInstances: false`. `withSeededOpenClawInstance` adds
`providerInstances.openclaw` when no OpenClaw instance exists. Hydration calls that helper at the
end of `deriveProviderInstanceConfigMap` so we do not rewrite the legacy five-driver loop.

Registration whitelist (expected nightly conflicts):

- `apps/server/src/provider/builtInDrivers.ts`
- `apps/web/src/components/settings/providerDriverMeta.ts` (and icon)
- `packages/contracts/src/model.ts` default / display maps
- `packages/contracts/src/index.ts` if the barrel export lands there

Anything else — especially `ChatComposer`, orchestration, `settings.ts` legacy struct, mobile
navigation — is a **stop**, not a resolve. See merge policy below.

`driverKind` is `openclaw`. If upstream ships a first-party driver with that slug, stop and rename.

## Merge policy

`main` on this repo is what we run. Remote `upstream` = `https://github.com/pingdotgg/t3code.git`.
Merge (do not rebase) the commit behind the latest T3 nightly tag, else `upstream/main`.

Run only overlay tests plus tests for touched whitelist files. No repo-wide `vp check`.

If `pnpm-lock.yaml` changes, it should be upstream's merge plus edits we intended. Do not regenerate
the whole lockfile to "make it green".

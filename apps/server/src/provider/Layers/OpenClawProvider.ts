import {
  ProviderDriverKind,
  type OpenClawSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as FileSystem from "node:fs/promises";
import * as Os from "node:os";
import * as NodePath from "node:path";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import {
  connectOpenClawGateway,
  listAgents,
  listModels,
  OpenClawGatewayError,
} from "../openclaw/gatewayClient.ts";
import { modelsFromCatalog, selectableAgents } from "../openclaw/catalog.ts";
import { isLoopbackGatewayUrl, normalizeGatewayUrl } from "../openclaw/protocol.ts";

const OPENCLAW_PRESENTATION = {
  displayName: "OpenClaw",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

const DRIVER = ProviderDriverKind.make("openclaw");

async function readSameHostBootstrapToken(): Promise<string | undefined> {
  const candidates = [
    NodePath.join(Os.homedir(), ".openclaw", "gateway.token"),
    NodePath.join(Os.homedir(), ".openclaw", "gateway", "token"),
  ];
  for (const candidate of candidates) {
    try {
      const text = await FileSystem.readFile(candidate, "utf8");
      if (text.trim()) return text.trim();
    } catch {
      // Try the next well-known path.
    }
  }
  return undefined;
}

export function buildInitialOpenClawProviderSnapshot(
  settings: OpenClawSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: OPENCLAW_PRESENTATION,
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenClaw is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Connecting to the OpenClaw Gateway...",
      },
    });
  });
}

export const checkOpenClawProviderStatus = Effect.fn("checkOpenClawProviderStatus")(function* (
  settings: OpenClawSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenClaw is disabled in T3 Code settings.",
      },
    });
  }

  const url = normalizeGatewayUrl(settings.gatewayUrl);
  const sameHostToken =
    !settings.bootstrapToken.trim() && isLoopbackGatewayUrl(url)
      ? yield* Effect.tryPromise({
          try: readSameHostBootstrapToken,
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
  const connection = yield* connectOpenClawGateway({
    url,
    ...(settings.bootstrapToken.trim() || sameHostToken
      ? { bootstrapToken: settings.bootstrapToken.trim() || sameHostToken }
      : {}),
  }).pipe(Effect.result);

  if (Result.isFailure(connection)) {
    const error = connection.failure;
    const pairing = error instanceof OpenClawGatewayError && Boolean(error.pairingRequired);
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: pairing ? "warning" : "error",
        auth: {
          status: "unauthenticated",
          type: pairing ? "pairing" : "gateway",
        },
        message: pairing
          ? `Approve this T3 Code device on the Gateway: ${error.pairingRequestId ?? "see openclaw devices list"}.`
          : error.message,
      },
    });
  }

  const live = connection.success;
  const agentsResult = yield* listAgents(live).pipe(Effect.result);
  const modelsResult = yield* listModels(live).pipe(Effect.result);
  yield* live.close;

  if (Result.isFailure(agentsResult)) {
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: live.hello.server?.version ?? null,
        status: "error",
        auth: { status: "authenticated" },
        message: agentsResult.failure.message,
      },
    });
  }

  const agents = selectableAgents(agentsResult.success);
  const models: ReadonlyArray<ServerProviderModel> = modelsFromCatalog({
    models: Result.isSuccess(modelsResult) ? modelsResult.success : [],
    agents,
    selectedAgentId: agentsResult.success.defaultId ?? agents[0]?.id,
    freezeAgent: false,
  });

  return buildServerProvider({
    presentation: OPENCLAW_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: live.hello.server?.version ?? "v4",
      status: "ok",
      auth: { status: "authenticated", type: "device" },
      message: `Connected to ${url}`,
    },
  });
});

export function withOpenClawInstanceIdentity(input: {
  readonly instanceId: ServerProvider["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationGroupKey: string;
}) {
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
}

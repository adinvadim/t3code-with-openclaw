export const OPENCLAW_PROTOCOL_VERSION = 4;
export const OPENCLAW_CLIENT_ID = "t3-code";
export const OPENCLAW_CLIENT_MODE = "operator";
export const OPENCLAW_OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
] as const;

export const DEFAULT_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

export type GatewayFrame =
  | {
      readonly type: "req";
      readonly id: string;
      readonly method: string;
      readonly params?: unknown;
    }
  | {
      readonly type: "res";
      readonly id: string;
      readonly ok: boolean;
      readonly payload?: unknown;
      readonly error?: GatewayErrorShape;
    }
  | {
      readonly type: "event";
      readonly event: string;
      readonly payload?: unknown;
      readonly seq?: number;
    };

export type GatewayErrorShape = {
  readonly code?: string;
  readonly message?: string;
  readonly details?: {
    readonly code?: string;
    readonly requestId?: string;
    readonly recommendedNextStep?: string;
    readonly reason?: string;
    readonly [key: string]: unknown;
  };
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
};

export type ConnectChallenge = {
  readonly nonce: string;
  readonly ts: number;
};

export type HelloOk = {
  readonly type?: string;
  readonly protocol: number;
  readonly server?: { readonly version?: string; readonly connId?: string };
  readonly features?: { readonly methods?: ReadonlyArray<string> };
  readonly snapshot?: unknown;
  readonly auth?: {
    readonly role?: string;
    readonly scopes?: ReadonlyArray<string>;
    readonly deviceToken?: string;
  };
  readonly policy?: {
    readonly maxPayload?: number;
    readonly maxBufferedBytes?: number;
    readonly tickIntervalMs?: number;
    readonly attachments?: { readonly maxBytes?: number; readonly maxImageBytes?: number };
  };
};

export type GatewayAgentRow = {
  readonly id: string;
  readonly name?: string;
  readonly workspace?: string;
  readonly kind?: string;
  readonly model?: { readonly primary?: string } | string;
  readonly thinkingDefault?: string;
};

export type GatewayAgentsListResult = {
  readonly defaultId?: string;
  readonly agents?: ReadonlyArray<GatewayAgentRow>;
};

export type GatewayModelRow = {
  readonly id?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly thinkingDefault?: string;
  readonly thinkingLevels?: ReadonlyArray<{ readonly id: string; readonly label?: string }>;
  readonly thinkingOptions?: ReadonlyArray<string>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGatewayFrame(raw: string): GatewayFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return undefined;
  }
  if (parsed.type === "req") {
    if (typeof parsed.id !== "string" || typeof parsed.method !== "string") return undefined;
    return {
      type: "req",
      id: parsed.id,
      method: parsed.method,
      ...(parsed.params !== undefined ? { params: parsed.params } : {}),
    };
  }
  if (parsed.type === "res") {
    if (typeof parsed.id !== "string" || typeof parsed.ok !== "boolean") return undefined;
    return {
      type: "res",
      id: parsed.id,
      ok: parsed.ok,
      ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
      ...(isRecord(parsed.error) ? { error: parsed.error as GatewayErrorShape } : {}),
    };
  }
  if (parsed.type === "event") {
    if (typeof parsed.event !== "string") return undefined;
    return {
      type: "event",
      event: parsed.event,
      ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
      ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
    };
  }
  return undefined;
}

export function parseConnectChallenge(payload: unknown): ConnectChallenge | undefined {
  if (!isRecord(payload)) return undefined;
  const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const ts = payload.ts;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) return undefined;
  return { nonce, ts };
}

export function parseHelloOk(payload: unknown): HelloOk | undefined {
  if (!isRecord(payload)) return undefined;
  const protocol = payload.protocol;
  if (typeof protocol !== "number") return undefined;
  return payload as HelloOk;
}

export function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim() || DEFAULT_OPENCLAW_GATEWAY_URL;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  return trimmed;
}

export function isLoopbackGatewayUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeGatewayUrl(url).replace(/^ws/i, "http"));
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

export function buildDeviceAuthPayloadV3(input: {
  readonly deviceId: string;
  readonly clientId: string;
  readonly clientMode: string;
  readonly role: string;
  readonly scopes: ReadonlyArray<string>;
  readonly signedAtMs: number;
  readonly token: string | null;
  readonly nonce: string;
  readonly platform: string;
  readonly deviceFamily: string;
}): string {
  const scopes = [...input.scopes].toSorted().join(",");
  return [
    "v3",
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    scopes,
    String(input.signedAtMs),
    input.token ?? "",
    input.nonce,
    input.platform.trim().toLowerCase(),
    input.deviceFamily.trim().toLowerCase(),
  ].join("|");
}

export function pairingRequestId(error: GatewayErrorShape | undefined): string | undefined {
  const details = error?.details;
  if (!details) return undefined;
  if (typeof details.requestId === "string" && details.requestId.trim()) {
    return details.requestId.trim();
  }
  if (typeof details.code === "string" && details.code.includes("PAIRING")) {
    return typeof details.reason === "string" ? details.reason : undefined;
  }
  return undefined;
}

export function isPairingRequired(error: GatewayErrorShape | undefined): boolean {
  const code = error?.details?.code ?? error?.code ?? "";
  return code.includes("PAIRING_REQUIRED") || code.includes("PAIRING");
}

export function sessionKeyForThread(agentId: string, threadId: string): string {
  return `agent:${agentId}:t3:${threadId}`;
}

export function parseOpenClawResume(raw: unknown):
  | { readonly schemaVersion: 1; readonly sessionKey: string; readonly agentId: string }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== 1) return undefined;
  if (typeof raw.sessionKey !== "string" || !raw.sessionKey.trim()) return undefined;
  if (typeof raw.agentId !== "string" || !raw.agentId.trim()) return undefined;
  return {
    schemaVersion: 1,
    sessionKey: raw.sessionKey.trim(),
    agentId: raw.agentId.trim(),
  };
}

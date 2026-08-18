import * as Os from "node:os";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import {
  type ConnectChallenge,
  type GatewayAgentsListResult,
  type GatewayErrorShape,
  type GatewayFrame,
  type GatewayModelRow,
  type HelloOk,
  isPairingRequired,
  OPENCLAW_CLIENT_ID,
  OPENCLAW_CLIENT_MODE,
  OPENCLAW_OPERATOR_SCOPES,
  OPENCLAW_PROTOCOL_VERSION,
  pairingRequestId,
  parseConnectChallenge,
  parseGatewayFrame,
  parseHelloOk,
} from "./protocol.ts";
import {
  loadDeviceToken,
  loadOrCreateDeviceIdentity,
  persistDeviceToken,
  signDeviceProof,
} from "./deviceIdentity.ts";

export class OpenClawGatewayError extends Schema.TaggedErrorClass<OpenClawGatewayError>()(
  "OpenClawGatewayError",
  {
    detail: Schema.String,
    code: Schema.optional(Schema.String),
    pairingRequestId: Schema.optional(Schema.String),
    pairingRequired: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type GatewayEvent = {
  readonly event: string;
  readonly payload: unknown;
};

export type OpenClawGatewayConnection = {
  readonly hello: HelloOk;
  readonly pairingRequestId: string | undefined;
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, OpenClawGatewayError>;
  readonly events: Stream.Stream<GatewayEvent>;
  readonly close: Effect.Effect<void>;
};

type Pending = {
  readonly succeed: (payload: unknown) => void;
  readonly fail: (error: OpenClawGatewayError) => void;
};

function errorFromShape(error: GatewayErrorShape | undefined, fallback: string): OpenClawGatewayError {
  return new OpenClawGatewayError({
    detail: error?.message?.trim() || fallback,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details?.code ? { code: error.details.code } : {}),
    ...(isPairingRequired(error) ? { pairingRequired: true } : {}),
    ...(pairingRequestId(error) ? { pairingRequestId: pairingRequestId(error) } : {}),
  });
}

export function connectOpenClawGateway(input: {
  readonly url: string;
  readonly bootstrapToken?: string;
}): Effect.Effect<OpenClawGatewayConnection, OpenClawGatewayError> {
  return Effect.gen(function* () {
    const identity = yield* loadOrCreateDeviceIdentity(input.url).pipe(
      Effect.mapError(
        (cause) =>
          new OpenClawGatewayError({
            detail: "Failed to load OpenClaw device identity.",
            cause,
          }),
      ),
    );
    const storedToken = yield* loadDeviceToken(input.url).pipe(
      Effect.mapError(
        (cause) =>
          new OpenClawGatewayError({
            detail: "Failed to load OpenClaw device token.",
            cause,
          }),
      ),
    );
    const bootstrapToken = input.bootstrapToken?.trim() || undefined;
    const authToken = storedToken ?? bootstrapToken;

    const socket = yield* Effect.try({
      try: () => new WebSocket(input.url),
      catch: (cause) =>
        new OpenClawGatewayError({
          detail: `Failed to open Gateway WebSocket at ${input.url}.`,
          cause,
        }),
    });

    const pending = new Map<string, Pending>();
    const events = yield* PubSub.unbounded<GatewayEvent>();
    const challenge = yield* Deferred.make<ConnectChallenge>();
    const hello = yield* Deferred.make<HelloOk>();
    const handshakeError = yield* Deferred.make<OpenClawGatewayError>();
    let nextId = 0;
    let closed = false;

    const failAll = (error: OpenClawGatewayError) => {
      for (const item of pending.values()) item.fail(error);
      pending.clear();
    };

    const sendJson = (frame: GatewayFrame) => {
      socket.send(JSON.stringify(frame));
    };

    socket.addEventListener("message", (message) => {
      const text = typeof message.data === "string" ? message.data : undefined;
      if (!text) return;
      const frame = parseGatewayFrame(text);
      if (!frame) return;
      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          const parsed = parseConnectChallenge(frame.payload);
          if (parsed) {
            void Effect.runFork(Deferred.succeed(challenge, parsed));
          } else {
            void Effect.runFork(
              Deferred.succeed(
                handshakeError,
                new OpenClawGatewayError({ detail: "Gateway sent an invalid connect.challenge." }),
              ),
            );
          }
          return;
        }
        void Effect.runFork(PubSub.publish(events, { event: frame.event, payload: frame.payload }));
        return;
      }
      if (frame.type === "res") {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.succeed(frame.payload);
        else waiter.fail(errorFromShape(frame.error, "Gateway request failed."));
      }
    });

    socket.addEventListener("error", () => {
      const error = new OpenClawGatewayError({ detail: "Gateway WebSocket error." });
      failAll(error);
      void Effect.runFork(Deferred.succeed(handshakeError, error));
    });

    socket.addEventListener("close", () => {
      closed = true;
      const error = new OpenClawGatewayError({ detail: "Gateway disconnected." });
      failAll(error);
      void Effect.runFork(Deferred.succeed(handshakeError, error));
    });

    yield* Effect.async<void, OpenClawGatewayError>((resume) => {
      if (socket.readyState === WebSocket.OPEN) {
        resume(Effect.void);
        return;
      }
      const onOpen = () => resume(Effect.void);
      const onError = () =>
        resume(
          Effect.fail(new OpenClawGatewayError({ detail: `Failed to connect to ${input.url}.` })),
        );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    const challengeOrError = yield* Deferred.await(challenge).pipe(
      Effect.race(Deferred.await(handshakeError).pipe(Effect.flip)),
      Effect.timeoutFail({
        duration: Duration.seconds(8),
        onTimeout: () =>
          new OpenClawGatewayError({
            detail: "Timed out waiting for Gateway connect.challenge.",
          }),
      }),
    );

    const request = (method: string, params?: unknown) =>
      Effect.async<unknown, OpenClawGatewayError>((resume) => {
        if (closed || socket.readyState !== WebSocket.OPEN) {
          resume(Effect.fail(new OpenClawGatewayError({ detail: "Gateway is not connected." })));
          return;
        }
        const id = `t3-${++nextId}`;
        pending.set(id, {
          succeed: (payload) => resume(Effect.succeed(payload)),
          fail: (error) => resume(Effect.fail(error)),
        });
        sendJson({
          type: "req",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      });

    const proof = signDeviceProof({
      identity,
      signedAtMs: challengeOrError.ts,
      nonce: challengeOrError.nonce,
      token: authToken ?? null,
      scopes: OPENCLAW_OPERATOR_SCOPES,
    });

    const connectId = "t3-connect";
    const helloPromise = Effect.async<unknown, OpenClawGatewayError>((resume) => {
      pending.set(connectId, {
        succeed: (payload) => resume(Effect.succeed(payload)),
        fail: (error) => resume(Effect.fail(error)),
      });
    });

    sendJson({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: OPENCLAW_PROTOCOL_VERSION,
        maxProtocol: OPENCLAW_PROTOCOL_VERSION,
        client: {
          id: OPENCLAW_CLIENT_ID,
          version: "0.0.33",
          platform: Os.platform(),
          mode: OPENCLAW_CLIENT_MODE,
        },
        role: "operator",
        scopes: [...OPENCLAW_OPERATOR_SCOPES],
        caps: ["tool-events", "approvals", "exec-approvals"],
        auth: authToken
          ? storedToken
            ? { deviceToken: storedToken }
            : { token: authToken }
          : {},
        locale: "en-US",
        userAgent: "t3-code/openclaw",
        device: proof,
      },
    });

    const helloPayload = yield* helloPromise.pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(10),
        onTimeout: () =>
          new OpenClawGatewayError({ detail: "Timed out waiting for Gateway hello-ok." }),
      }),
    );
    const parsedHello = parseHelloOk(helloPayload);
    if (!parsedHello) {
      return yield* new OpenClawGatewayError({ detail: "Gateway hello-ok was not protocol v4." });
    }
    if (parsedHello.protocol !== OPENCLAW_PROTOCOL_VERSION) {
      return yield* new OpenClawGatewayError({
        detail: `Need OpenClaw Gateway protocol v${OPENCLAW_PROTOCOL_VERSION}.`,
      });
    }
    if (parsedHello.auth?.deviceToken) {
      yield* persistDeviceToken(input.url, parsedHello.auth.deviceToken).pipe(
        Effect.mapError(
          (cause) =>
            new OpenClawGatewayError({
              detail: "Failed to persist OpenClaw device token.",
              cause,
            }),
        ),
      );
    }
    yield* Deferred.succeed(hello, parsedHello);

    const tickMs = parsedHello.policy?.tickIntervalMs ?? 15_000;
    const ticker = yield* Effect.fork(
      Effect.forever(
        Effect.sleep(Duration.millis(tickMs)).pipe(
          Effect.andThen(request("health").pipe(Effect.ignore)),
        ),
      ),
    );

    const close = Effect.sync(() => {
      closed = true;
      socket.close();
    }).pipe(Effect.tap(() => Fiber.interrupt(ticker)), Effect.asVoid);

    return {
      hello: parsedHello,
      pairingRequestId: undefined,
      request,
      events: Stream.fromPubSub(events),
      close,
    } satisfies OpenClawGatewayConnection;
  }).pipe(
    Effect.catchIf(
      (error): error is OpenClawGatewayError => error instanceof OpenClawGatewayError,
      (error) => Effect.fail(error),
    ),
  );
}

export function listAgents(connection: OpenClawGatewayConnection) {
  return connection.request("agents.list").pipe(
    Effect.map((payload): GatewayAgentsListResult => {
      if (!payload || typeof payload !== "object") return {};
      return payload as GatewayAgentsListResult;
    }),
  );
}

export function listModels(connection: OpenClawGatewayConnection, agentId?: string) {
  return connection
    .request("models.list", {
      preparedOnly: true,
      ...(agentId ? { agentId } : {}),
    })
    .pipe(
      Effect.map((payload): ReadonlyArray<GatewayModelRow> => {
        if (Array.isArray(payload)) return payload as GatewayModelRow[];
        if (payload && typeof payload === "object" && "models" in payload) {
          const models = (payload as { models?: unknown }).models;
          return Array.isArray(models) ? (models as GatewayModelRow[]) : [];
        }
        return [];
      }),
    );
}

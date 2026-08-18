import {
  EventId,
  type OpenClawSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as FileSystem from "node:fs/promises";
import * as Os from "node:os";
import * as NodePath from "node:path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  connectOpenClawGateway,
  listAgents,
  type OpenClawGatewayConnection,
} from "../openclaw/gatewayClient.ts";
import { agentWorkspace, defaultAgentId, selectableAgents } from "../openclaw/catalog.ts";
import {
  isLoopbackGatewayUrl,
  isRecord,
  normalizeGatewayUrl,
  parseOpenClawResume,
  sessionKeyForThread,
} from "../openclaw/protocol.ts";
import type { OpenClawAdapterShape } from "../Services/OpenClawAdapter.ts";

const PROVIDER = ProviderDriverKind.make("openclaw");

export interface OpenClawAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

interface OpenClawSessionContext {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
  readonly agentId: string;
  session: ProviderSession;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  pendingApprovalIds: Set<string>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  assistantItemId: string | undefined;
  stopped: boolean;
}

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
      // next
    }
  }
  return undefined;
}

function eventSessionKey(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.sessionKey === "string") return payload.sessionKey;
  if (typeof payload.key === "string") return payload.key;
  if (isRecord(payload.session) && typeof payload.session.key === "string") {
    return payload.session.key;
  }
  return undefined;
}

export function makeOpenClawAdapter(
  settings: OpenClawSettings,
  options?: OpenClawAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("openclaw");
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* ServerConfig;
    const sessions = new Map<ThreadId, OpenClawSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sharedConnection = yield* SynchronizedRef.make<OpenClawGatewayConnection | null>(null);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenClaw identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
        createdAt: nowIso,
      });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const ensureConnection = Effect.fn("ensureOpenClawConnection")(function* () {
      const existing = yield* SynchronizedRef.get(sharedConnection);
      if (existing) return existing;
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
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "connect",
              detail: cause.message,
              cause,
            }),
        ),
      );
      yield* SynchronizedRef.set(sharedConnection, connection);
      return connection;
    });

    const handleGatewayEvent = (ctx: OpenClawSessionContext, event: string, payload: unknown) =>
      Effect.gen(function* () {
        const key = eventSessionKey(payload);
        if (key && key !== ctx.sessionKey) return;
        const stamp = yield* makeEventStamp();
        const turnId = ctx.activeTurnId;

        if (event === "chat" || event.startsWith("chat.")) {
          const text =
            isRecord(payload) && typeof payload.deltaText === "string"
              ? payload.deltaText
              : isRecord(payload) && typeof payload.text === "string"
                ? payload.text
                : "";
          if (!text || !turnId) return;
          if (!ctx.assistantItemId) {
            ctx.assistantItemId = yield* randomUUIDv4;
            yield* offerRuntimeEvent({
              type: "item.started",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              itemId: RuntimeItemId.make(ctx.assistantItemId),
              payload: { itemType: "assistant_message", status: "inProgress" },
            });
          }
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(ctx.assistantItemId),
            payload: { streamKind: "assistant_text", delta: text },
          });
          return;
        }

        if (event.includes("tool")) {
          if (!turnId) return;
          const toolId =
            isRecord(payload) && typeof payload.id === "string"
              ? payload.id
              : isRecord(payload) && typeof payload.toolCallId === "string"
                ? payload.toolCallId
                : yield* randomUUIDv4;
          const title =
            isRecord(payload) && typeof payload.name === "string"
              ? payload.name
              : isRecord(payload) && typeof payload.tool === "string"
                ? payload.tool
                : "tool";
          const status =
            isRecord(payload) && (payload.status === "completed" || payload.status === "failed")
              ? payload.status
              : "inProgress";
          yield* offerRuntimeEvent({
            type: status === "inProgress" ? "item.updated" : "item.completed",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolId),
            payload: { itemType: "dynamic_tool_call", status, title },
          });
          return;
        }

        if (event.includes("approval") && !event.includes("resolved")) {
          if (!turnId) return;
          const requestIdRaw =
            isRecord(payload) && typeof payload.id === "string" ? payload.id : yield* randomUUIDv4;
          if (ctx.pendingApprovalIds.has(requestIdRaw)) return;
          ctx.pendingApprovalIds.add(requestIdRaw);
          yield* offerRuntimeEvent({
            type: "request.opened",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            requestId: RuntimeRequestId.make(requestIdRaw),
            payload: {
              requestType: "exec_command_approval",
              detail:
                isRecord(payload) && typeof payload.command === "string"
                  ? payload.command
                  : "OpenClaw requested approval.",
              args: payload,
            },
          });
          return;
        }

        if (event.includes("question")) {
          if (!turnId) return;
          const requestIdRaw =
            isRecord(payload) && typeof payload.id === "string" ? payload.id : yield* randomUUIDv4;
          const prompt =
            isRecord(payload) && typeof payload.prompt === "string"
              ? payload.prompt
              : "OpenClaw asked a question.";
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            requestId: RuntimeRequestId.make(requestIdRaw),
            payload: {
              questions: [
                {
                  id: requestIdRaw,
                  header: "OpenClaw",
                  question: prompt,
                  options: [],
                },
              ],
            },
          });
        }
      });

    const stopSessionInternal = (ctx: OpenClawSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        const connection = yield* SynchronizedRef.get(sharedConnection);
        if (ctx.activeTurnId && connection) {
          yield* connection.request("sessions.abort", { key: ctx.sessionKey }).pipe(Effect.ignore);
        }
        if (connection) {
          yield* connection
            .request("sessions.messages.unsubscribe", { key: ctx.sessionKey })
            .pipe(Effect.ignore);
        }
        if (ctx.eventFiber) yield* Fiber.interrupt(ctx.eventFiber).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: OpenClawAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const connection = yield* ensureConnection();
          const agents = yield* listAgents(connection).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agents.list",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const resume = parseOpenClawResume(input.resumeCursor);
          const requestedAgent =
            getModelSelectionStringOptionValue(input.modelSelection, "agent") ??
            resume?.agentId ??
            defaultAgentId(agents);
          const agent = selectableAgents(agents).find((row) => row.id === requestedAgent);
          if (!agent || !requestedAgent) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: "No OpenClaw agent is available on the Gateway.",
            });
          }
          const cwd = agentWorkspace(agent);
          if (!cwd) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: `OpenClaw agent '${agent.id}' has no workspace.`,
            });
          }

          const sessionKey = resume?.sessionKey ?? sessionKeyForThread(agent.id, input.threadId);
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: 1, sessionKey, agentId: agent.id },
            createdAt: now,
            updatedAt: now,
          };
          const ctx: OpenClawSessionContext = {
            threadId: input.threadId,
            sessionKey,
            agentId: agent.id,
            session,
            eventFiber: undefined,
            pendingApprovalIds: new Set(),
            turns: [],
            activeTurnId: undefined,
            assistantItemId: undefined,
            stopped: false,
          };
          sessions.set(input.threadId, ctx);
          ctx.eventFiber = yield* Stream.runDrain(
            Stream.mapEffect(connection.events, (event) =>
              handleGatewayEvent(ctx, event.event, event.payload).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to project OpenClaw gateway event.", { cause }),
                ),
              ),
            ),
          ).pipe(
            Effect.catchCause(() =>
              Effect.gen(function* () {
                const live = sessions.get(input.threadId);
                if (!live || live.stopped || !live.activeTurnId) return;
                yield* offerRuntimeEvent({
                  type: "turn.aborted",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: live.activeTurnId,
                  payload: { reason: "Gateway disconnected." },
                });
                live.session = {
                  ...live.session,
                  status: "error",
                  lastError: "Gateway disconnected.",
                  updatedAt: yield* nowIso,
                };
              }),
            ),
            Effect.fork,
          );

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: session.resumeCursor },
          });
          return session;
        }),
      );

    const sendTurn: OpenClawAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const connection = yield* ensureConnection();
          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "OpenClaw is already running a turn on this thread.",
            });
          }
          const requestedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
          if (requestedAgent && requestedAgent !== ctx.agentId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "This OpenClaw thread is locked to a different agent.",
            });
          }

          const attachments = [];
          for (const attachment of input.attachments ?? []) {
            const filePath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!filePath) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Could not resolve attachment ${attachment.id}.`,
              });
            }
            const bytes = yield* Effect.tryPromise({
              try: () => FileSystem.readFile(filePath),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: `Failed to read attachment ${attachment.id}.`,
                  cause,
                }),
            });
            attachments.push({
              type: "image",
              mimeType: attachment.mimeType,
              name: attachment.name,
              content: Buffer.from(bytes).toString("base64"),
            });
          }

          const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
          const model = input.modelSelection?.model;
          const sendParams = {
            key: ctx.sessionKey,
            message: input.input ?? "",
            ...(model ? { model } : {}),
            ...(thinking ? { thinkingLevel: thinking } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          const created = yield* connection
            .request("sessions.create", {
              ...sendParams,
              agentId: ctx.agentId,
              label: "T3",
              category: "T3",
            })
            .pipe(
              Effect.catch(() => connection.request("sessions.send", sendParams)),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "sessions.create",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          void created;

          yield* connection
            .request("sessions.messages.subscribe", {
              key: ctx.sessionKey,
              includeApprovals: true,
            })
            .pipe(Effect.ignore);

          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.assistantItemId = undefined;
          ctx.turns = [...ctx.turns, { id: turnId, items: [] }];
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(model ? { model } : {}),
            resumeCursor: { schemaVersion: 1, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
          };
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              ...(model ? { model } : {}),
              ...(thinking ? { effort: thinking } : {}),
            },
          });
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: OpenClawAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const connection = yield* ensureConnection();
          yield* connection.request("sessions.abort", { key: ctx.sessionKey }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sessions.abort",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          if (ctx.activeTurnId) {
            yield* offerRuntimeEvent({
              type: "turn.aborted",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: ctx.activeTurnId,
              payload: { reason: "interrupted" },
            });
          }
          const { activeTurnId: _omit, ...ready } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = { ...ready, status: "ready", updatedAt: yield* nowIso };
        }),
      );

    const respondToRequest: OpenClawAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const connection = yield* ensureConnection();
        const resolved = decision === "decline" || decision === "cancel" ? "deny" : "allow";
        yield* connection.request("approval.resolve", { id: requestId, decision: resolved }).pipe(
          Effect.catch(() =>
            connection.request("exec.approval.resolve", { id: requestId, decision: resolved }),
          ),
          Effect.ignore,
        );
        yield* offerRuntimeEvent({
          type: "request.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: "exec_command_approval", decision },
        });
        ctx.pendingApprovalIds.delete(requestId);
      });

    const respondToUserInput: OpenClawAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        const connection = yield* ensureConnection();
        yield* connection.request("approval.resolve", { id: requestId, answers }).pipe(Effect.ignore);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      });

    const readThread: OpenClawAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OpenClawAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenClaw sessions do not support provider-side rollback in v1.",
        });
      });

    const stopSession: OpenClawAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: OpenClawAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: OpenClawAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: OpenClawAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() =>
          SynchronizedRef.get(sharedConnection).pipe(
            Effect.flatMap((connection) => (connection ? connection.close : Effect.void)),
            Effect.tap(() => SynchronizedRef.set(sharedConnection, null)),
          ),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies OpenClawAdapterShape;
  });
}

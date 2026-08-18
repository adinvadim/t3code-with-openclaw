import { describe, expect, it } from "vite-plus/test";

import {
  buildDeviceAuthPayloadV3,
  isLoopbackGatewayUrl,
  normalizeGatewayUrl,
  parseConnectChallenge,
  parseGatewayFrame,
  sessionKeyForThread,
} from "./protocol.ts";

describe("openclaw protocol helpers", () => {
  it("parses challenge, response, and event frames", () => {
    expect(
      parseGatewayFrame(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "abc", ts: 10 },
        }),
      ),
    ).toEqual({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "abc", ts: 10 },
    });
    expect(parseConnectChallenge({ nonce: "abc", ts: 10 })).toEqual({ nonce: "abc", ts: 10 });
    expect(parseConnectChallenge({ nonce: "abc", ts: "nope" })).toBeUndefined();
    expect(
      parseGatewayFrame(JSON.stringify({ type: "res", id: "1", ok: true, payload: { protocol: 4 } })),
    ).toMatchObject({ type: "res", id: "1", ok: true });
  });

  it("normalizes gateway URLs and loopback detection", () => {
    expect(normalizeGatewayUrl("http://127.0.0.1:18789")).toBe("ws://127.0.0.1:18789");
    expect(normalizeGatewayUrl("https://gateway.example/ws")).toBe("wss://gateway.example/ws");
    expect(isLoopbackGatewayUrl("ws://127.0.0.1:18789")).toBe(true);
    expect(isLoopbackGatewayUrl("wss://example.test")).toBe(false);
  });

  it("builds a stable v3 device payload", () => {
    expect(
      buildDeviceAuthPayloadV3({
        deviceId: "dev",
        clientId: "t3-code",
        clientMode: "operator",
        role: "operator",
        scopes: ["operator.write", "operator.read"],
        signedAtMs: 1,
        token: "tok",
        nonce: "n",
        platform: "Darwin",
        deviceFamily: "Desktop",
      }),
    ).toBe("v3|dev|t3-code|operator|operator|operator.read,operator.write|1|tok|n|darwin|desktop");
  });

  it("builds isolated session keys", () => {
    expect(sessionKeyForThread("dev", "thr_1")).toBe("agent:dev:t3:thr_1");
  });
});

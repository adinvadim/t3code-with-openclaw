import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DEFAULT_OPENCLAW_GATEWAY_URL, OpenClawSettings } from "./openclawSettings.ts";

const decode = Schema.decodeUnknownSync(OpenClawSettings);

describe("OpenClawSettings", () => {
  it("defaults to the local Gateway URL", () => {
    expect(decode({})).toEqual({
      enabled: true,
      gatewayUrl: DEFAULT_OPENCLAW_GATEWAY_URL,
      bootstrapToken: "",
    });
  });

  it("keeps a custom URL and bootstrap token", () => {
    expect(
      decode({
        gatewayUrl: "wss://gateway.example:18789",
        bootstrapToken: "secret",
      }),
    ).toMatchObject({
      gatewayUrl: "wss://gateway.example:18789",
      bootstrapToken: "secret",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { withSeededOpenClawInstance } from "./seedInstance.ts";

describe("withSeededOpenClawInstance", () => {
  it("seeds a default OpenClaw instance when none exists", () => {
    const seeded = withSeededOpenClawInstance({});
    const instance = seeded[ProviderInstanceId.make("openclaw")];
    expect(instance?.driver).toBe(ProviderDriverKind.make("openclaw"));
    expect(instance?.config).toMatchObject({
      enabled: true,
      gatewayUrl: "ws://127.0.0.1:18789",
    });
  });

  it("does not replace an existing OpenClaw instance", () => {
    const existingId = ProviderInstanceId.make("openclaw_work");
    const seeded = withSeededOpenClawInstance({
      [existingId]: {
        driver: ProviderDriverKind.make("openclaw"),
        displayName: "Work",
        config: { gatewayUrl: "wss://example.test" },
      },
    });
    expect(seeded[ProviderInstanceId.make("openclaw")]).toBeUndefined();
    expect(seeded[existingId]?.displayName).toBe("Work");
  });
});

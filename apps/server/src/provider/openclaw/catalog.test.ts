import { describe, expect, it } from "vite-plus/test";

import { defaultAgentId, modelsFromCatalog, selectableAgents } from "./catalog.ts";

describe("openclaw catalog", () => {
  it("skips system agents and prefers defaultId", () => {
    const list = {
      defaultId: "dev",
      agents: [
        { id: "main", kind: "system" },
        { id: "dev", name: "Dev" },
        { id: "archie", name: "Archie" },
      ],
    };
    expect(selectableAgents(list).map((agent) => agent.id)).toEqual(["dev", "archie"]);
    expect(defaultAgentId(list)).toBe("dev");
  });

  it("puts thinking first and can freeze the agent option", () => {
    const models = modelsFromCatalog({
      models: [{ id: "anthropic/claude-sonnet-4-6", name: "Sonnet", thinkingDefault: "low" }],
      agents: [
        { id: "dev", name: "Dev" },
        { id: "archie", name: "Archie" },
      ],
      selectedAgentId: "dev",
      freezeAgent: true,
    });
    const descriptors = models[0]?.capabilities?.optionDescriptors ?? [];
    expect(descriptors[0]?.id).toBe("thinking");
    expect(descriptors[1]?.id).toBe("agent");
    expect(descriptors[1] && "options" in descriptors[1] ? descriptors[1].options : []).toEqual([
      expect.objectContaining({ id: "dev" }),
    ]);
  });
});

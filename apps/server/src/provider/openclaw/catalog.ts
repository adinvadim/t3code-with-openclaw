import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import type { GatewayAgentRow, GatewayAgentsListResult, GatewayModelRow } from "./protocol.ts";

export const OPENCLAW_DRIVER_KIND = ProviderDriverKind.make("openclaw");

export function selectableAgents(list: GatewayAgentsListResult): ReadonlyArray<GatewayAgentRow> {
  return (list.agents ?? []).filter((agent) => agent.kind !== "system" && Boolean(agent.id));
}

export function defaultAgentId(list: GatewayAgentsListResult): string | undefined {
  const agents = selectableAgents(list);
  if (list.defaultId && agents.some((agent) => agent.id === list.defaultId)) {
    return list.defaultId;
  }
  return agents[0]?.id;
}

export function agentWorkspace(agent: GatewayAgentRow | undefined): string | undefined {
  const workspace = agent?.workspace?.trim();
  return workspace ? workspace : undefined;
}

export function agentPrimaryModel(agent: GatewayAgentRow | undefined): string | undefined {
  if (!agent) return undefined;
  if (typeof agent.model === "string" && agent.model.trim()) return agent.model.trim();
  const primary = agent.model && typeof agent.model === "object" ? agent.model.primary : undefined;
  return primary?.trim() || undefined;
}

function thinkingChoices(model: GatewayModelRow): ReadonlyArray<{ value: string; label: string }> {
  if (model.thinkingLevels?.length) {
    return model.thinkingLevels.map((level) => ({
      value: level.id,
      label: level.label?.trim() || level.id,
    }));
  }
  if (model.thinkingOptions?.length) {
    return model.thinkingOptions.map((option) => ({ value: option, label: option }));
  }
  return [
    { value: "off", label: "Off" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];
}

export function modelsFromCatalog(input: {
  readonly models: ReadonlyArray<GatewayModelRow>;
  readonly agents: ReadonlyArray<GatewayAgentRow>;
  readonly selectedAgentId: string | undefined;
  readonly freezeAgent: boolean;
}): ReadonlyArray<ServerProviderModel> {
  const agentOptions = input.agents.map((agent) => ({
    value: agent.id,
    label: agent.name?.trim() || agent.id,
    isDefault: agent.id === input.selectedAgentId,
  }));
  const frozenAgentOptions =
    input.freezeAgent && input.selectedAgentId
      ? agentOptions.filter((option) => option.value === input.selectedAgentId)
      : agentOptions;

  const rows = input.models.length
    ? input.models
    : [
        {
          id: DEFAULT_MODEL_BY_PROVIDER[OPENCLAW_DRIVER_KIND],
          name: "OpenClaw default",
        } satisfies GatewayModelRow,
      ];

  return rows.flatMap((model): ServerProviderModel[] => {
    const slug = model.id?.trim();
    if (!slug) return [];
    const thinking = thinkingChoices(model);
    const defaultThinking = model.thinkingDefault ?? thinking[0]?.value;
    return [
      {
        slug,
        name: model.name?.trim() || slug,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            buildSelectOptionDescriptor({
              id: "thinking",
              label: "Thinking",
              options: thinking.map((choice) => ({
                ...choice,
                isDefault: choice.value === defaultThinking,
              })),
            }),
            ...(frozenAgentOptions.length > 0
              ? [
                  buildSelectOptionDescriptor({
                    id: "agent",
                    label: "Agent",
                    options: frozenAgentOptions,
                  }),
                ]
              : []),
          ],
        }),
      },
    ];
  });
}

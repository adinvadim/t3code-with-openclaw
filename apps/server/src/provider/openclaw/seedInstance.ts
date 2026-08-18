import {
  defaultInstanceIdForDriver,
  OpenClawSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);
const DRIVER = ProviderDriverKind.make("openclaw");

export function withSeededOpenClawInstance(
  instances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  const hasOpenClaw = Object.values(instances).some((entry) => entry.driver === DRIVER);
  if (hasOpenClaw) return instances;
  const instanceId = defaultInstanceIdForDriver(DRIVER);
  const seeded: ProviderInstanceConfig = {
    driver: DRIVER,
    displayName: "OpenClaw",
    config: decodeOpenClawSettings({}),
  };
  return {
    ...instances,
    [instanceId]: seeded,
  };
}

import { OpenClawSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenClawAdapter } from "../Layers/OpenClawAdapter.ts";
import {
  buildInitialOpenClawProviderSnapshot,
  checkOpenClawProviderStatus,
  withOpenClawInstanceIdentity,
} from "../Layers/OpenClawProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeOpenClawTextGeneration } from "../openclaw/textGeneration.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ServerConfig } from "../../config.ts";

const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);
const DRIVER_KIND = ProviderDriverKind.make("openclaw");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type OpenClawDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerSettingsService;

export const OpenClawDriver: ProviderDriver<OpenClawSettings, OpenClawDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenClaw",
    supportsMultipleInstances: false,
  },
  configSchema: OpenClawSettings,
  defaultConfig: (): OpenClawSettings => decodeOpenClawSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withOpenClawInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenClawSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {});
      const adapter = yield* makeOpenClawAdapter(effectiveConfig, { instanceId });
      const textGeneration = makeOpenClawTextGeneration();
      const checkProvider = checkOpenClawProviderStatus(effectiveConfig).pipe(Effect.map(stampIdentity));
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenClawSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOpenClawProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenClaw snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

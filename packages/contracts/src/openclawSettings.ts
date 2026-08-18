import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

export const DEFAULT_OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

const openClawSettingsFields = {
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  gatewayUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_OPENCLAW_GATEWAY_URL)),
    Schema.annotateKey({
      title: "Gateway URL",
      description: "WebSocket URL of a running OpenClaw Gateway.",
      providerSettingsForm: {
        placeholder: DEFAULT_OPENCLAW_GATEWAY_URL,
        clearWhenEmpty: "omit",
      },
    }),
  ),
  bootstrapToken: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Bootstrap token",
      description:
        "Shared Gateway token or password used only to start device pairing. Leave empty on loopback if T3 Code can read the local Gateway token.",
      providerSettingsForm: {
        control: "password",
        placeholder: "Optional",
        clearWhenEmpty: "omit",
      },
    }),
  ),
};

const OpenClawSettingsStruct = Schema.Struct(openClawSettingsFields).pipe(
  Schema.annotate({
    providerSettingsFormSchema: { order: ["gatewayUrl", "bootstrapToken"] },
  }),
);

export const OpenClawSettings = Object.assign(OpenClawSettingsStruct, {
  fields: openClawSettingsFields,
});
export type OpenClawSettings = typeof OpenClawSettingsStruct.Type;

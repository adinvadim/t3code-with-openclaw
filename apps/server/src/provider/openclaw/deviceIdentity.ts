import * as Crypto from "node:crypto";
import * as Os from "node:os";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { buildDeviceAuthPayloadV3 } from "./protocol.ts";

const StoredDeviceIdentity = Schema.Struct({
  deviceId: Schema.String,
  publicKey: Schema.String,
  privateKeyPkcs8: Schema.String,
});
type StoredDeviceIdentity = typeof StoredDeviceIdentity.Type;

const decodeIdentity = Schema.decodeUnknownSync(StoredDeviceIdentity);
const encodeIdentity = Schema.encodeSync(StoredDeviceIdentity);

export type DeviceProof = {
  readonly id: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly signedAt: number;
  readonly nonce: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  return Crypto.createHash("sha256").update(publicKey).digest("hex");
}

function secretNameForGateway(gatewayUrl: string, kind: "identity" | "token"): string {
  const digest = Crypto.createHash("sha256").update(gatewayUrl).digest("hex").slice(0, 24);
  return `openclaw-${kind}-${digest}`;
}

function rawPublicKeyFromSpki(spki: Buffer): Uint8Array {
  return new Uint8Array(spki.subarray(-32));
}

export function loadOrCreateDeviceIdentity(gatewayUrl: string) {
  return Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const name = secretNameForGateway(gatewayUrl, "identity");
    const existing = yield* store.get(name);
    if (Option.isSome(existing)) {
      try {
        return decodeIdentity(JSON.parse(Buffer.from(existing.value).toString("utf8")));
      } catch {
        // Mint a replacement if the stored blob is unreadable.
      }
    }

    const { privateKey, publicKey } = Crypto.generateKeyPairSync("ed25519");
    const publicSpki = publicKey.export({ type: "spki", format: "der" });
    const identity: StoredDeviceIdentity = {
      deviceId: fingerprintPublicKey(rawPublicKeyFromSpki(publicSpki)),
      publicKey: bytesToBase64Url(rawPublicKeyFromSpki(publicSpki)),
      privateKeyPkcs8: Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString(
        "base64url",
      ),
    };
    yield* store.set(name, new TextEncoder().encode(JSON.stringify(encodeIdentity(identity))));
    return identity;
  });
}

export function loadDeviceToken(gatewayUrl: string) {
  return Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const existing = yield* store.get(secretNameForGateway(gatewayUrl, "token"));
    return Option.match(existing, {
      onNone: () => undefined,
      onSome: (bytes) => Buffer.from(bytes).toString("utf8") || undefined,
    });
  });
}

export function persistDeviceToken(gatewayUrl: string, token: string) {
  return Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    yield* store.set(secretNameForGateway(gatewayUrl, "token"), new TextEncoder().encode(token));
  });
}

export function signDeviceProof(input: {
  readonly identity: StoredDeviceIdentity;
  readonly signedAtMs: number;
  readonly nonce: string;
  readonly token: string | null;
  readonly scopes: ReadonlyArray<string>;
}): DeviceProof {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: input.identity.deviceId,
    clientId: "t3-code",
    clientMode: "operator",
    role: "operator",
    scopes: input.scopes,
    signedAtMs: input.signedAtMs,
    token: input.token,
    nonce: input.nonce,
    platform: Os.platform(),
    deviceFamily: "desktop",
  });
  const key = Crypto.createPrivateKey({
    key: Buffer.from(input.identity.privateKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const signature = Crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return {
    id: input.identity.deviceId,
    publicKey: input.identity.publicKey,
    signature: bytesToBase64Url(new Uint8Array(signature)),
    signedAt: input.signedAtMs,
    nonce: input.nonce,
  };
}

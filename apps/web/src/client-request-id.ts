type ClientCrypto = Readonly<{
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}>;

let legacySequence = 0;

const formatUuid = (bytes: Uint8Array): string => {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
};

const legacyRandomBytes = (): Uint8Array => {
  legacySequence = (legacySequence + 1) >>> 0;
  const bytes = Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  const timestamp = Date.now();
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = bytes[index]! ^ (Math.floor(timestamp / (2 ** (index * 8))) & 0xff);
  }
  for (let index = 0; index < 4; index += 1) {
    bytes[12 + index] = bytes[12 + index]! ^ ((legacySequence >>> (index * 8)) & 0xff);
  }
  return bytes;
};

export const createClientRequestId = (
  provider: ClientCrypto | null | undefined = globalThis.crypto,
): string => {
  if (typeof provider?.randomUUID === "function") {
    try {
      return provider.randomUUID();
    } catch {
      // Older embedded browsers can expose the method but reject the call.
    }
  }

  if (typeof provider?.getRandomValues === "function") {
    try {
      return formatUuid(provider.getRandomValues(new Uint8Array(16)));
    } catch {
      // Fall through for legacy WebViews without a usable Web Crypto implementation.
    }
  }

  // This identifier only deduplicates a client request; it is not an authentication secret.
  return formatUuid(legacyRandomBytes());
};

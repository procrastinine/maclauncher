const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectManagedAssembly } = require("../managed-assembly");

const MAX_BYTES = 8 * 1024 * 1024;
const LIBRARY = /^(?:lib)?steam_api(?:64)?(?:\.(?:dll|dylib|so|bundle))?$/i;
const SYMBOL = /^(?:Steam[A-Za-z0-9_]{0,160}|GetHSteam(?:User|Pipe))$/;
const SHA = /^[a-f0-9]{64}$/;
const failure = (code, message) => Object.assign(new Error(message), { code });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const unique = values => [...new Set(values)].sort();

function importIdentity(imports) {
  return hash(Buffer.from(JSON.stringify(imports.map(item => [item.library, item.name])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))));
}

function validateConsumerProfile(value) {
  if (value?.schemaVersion !== 1 || !SHA.test(value.assemblySha256 || "") ||
      !Number.isSafeInteger(value.assemblyBytes) || value.assemblyBytes < 256 || value.assemblyBytes > MAX_BYTES ||
      typeof value.assemblyName !== "string" || !value.assemblyName || value.assemblyName.length > 256 ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(value.assemblyVersion || "") || !SHA.test(value.nativeImportsSha256 || "") ||
      !Array.isArray(value.requiredSymbols) || !value.requiredSymbols.length || value.requiredSymbols.length > 4096 ||
      new Set(value.requiredSymbols).size !== value.requiredSymbols.length ||
      value.requiredSymbols.some(symbol => typeof symbol !== "string" || !SYMBOL.test(symbol))) {
    throw failure("STEAM_API_PROFILE_CHANGED", "The managed Steam API profile is invalid.");
  }
  return value;
}

async function readConsumer(source, expected, signal) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(source?.assemblyPath || "") || /[\0\r\n]/.test(source.assemblyPath)) {
    throw failure("STEAM_API_CONSUMER_INVALID", "A managed Steam API assembly path must be absolute.");
  }
  const range = source.range;
  if (range !== undefined && (!range || !Number.isSafeInteger(range.offset) || range.offset < 0 ||
      !Number.isSafeInteger(range.size) || range.size !== expected.assemblyBytes)) {
    throw failure("STEAM_API_CONSUMER_INVALID", "The managed Steam API assembly byte range is invalid.");
  }
  let handle;
  try {
    handle = await fs.promises.open(source.assemblyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const start = range?.offset || 0, size = range?.size ?? Number(before.size);
    if (!before.isFile() || !Number.isSafeInteger(size) || size !== expected.assemblyBytes ||
        BigInt(start) + BigInt(size) > before.size) {
      throw failure("STEAM_API_CONSUMER_CHANGED", "The managed Steam API assembly size changed.");
    }
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(size - offset, 1024 * 1024), start + offset);
      if (!read.bytesRead) throw failure("STEAM_API_CONSUMER_CHANGED", "The managed Steam API assembly is incomplete.");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        hash(bytes) !== expected.assemblySha256) {
      throw failure("STEAM_API_CONSUMER_CHANGED", "The managed Steam API assembly checksum changed.");
    }
    // Parse the same immutable memory snapshot that was hashed. No assembly is
    // loaded or extracted, including when the source is a PE resource range.
    const metadata = inspectManagedAssembly(source.assemblyPath, { maxMetadataBytes: MAX_BYTES,
      detection: { stat: () => ({ size: bytes.length, isFile: () => true }),
        readBytes: (_file, offset, length) => bytes.subarray(offset, offset + length) } });
    if (metadata.assemblyName !== expected.assemblyName || metadata.assemblyVersion !== expected.assemblyVersion ||
        !metadata.ilOnly || metadata.nativeEntryPoint || metadata.hasNativeManagedCode || metadata.requires32Bit) {
      throw failure("STEAM_API_CONSUMER_CHANGED", "The managed Steam API assembly identity or CLR architecture changed.");
    }
    const imports = metadata.nativeImports.filter(item => LIBRARY.test(item.library));
    if (!imports.length || importIdentity(imports) !== expected.nativeImportsSha256) {
      throw failure("STEAM_API_CONSUMER_CHANGED", "The managed Steam API assembly import table changed.");
    }
    const declaredSymbols = unique(imports.map(item => item.name));
    if (expected.requiredSymbols.some(symbol => !declaredSymbols.includes(symbol))) {
      throw failure("STEAM_API_PROFILE_CHANGED", "The managed Steam API profile names an undeclared function.");
    }
    return { assemblySha256: expected.assemblySha256, assemblyBytes: bytes.length,
      assemblyName: metadata.assemblyName, assemblyVersion: metadata.assemblyVersion,
      declaredSymbols, requiredSymbols: [...expected.requiredSymbols] };
  } finally { await handle?.close(); }
}

/** Lazy P/Invokes are bounded by an exact assembly and its trusted ABI profile. */
async function resolveManagedRequirement({ profile, sources, symbols, signal } = {}) {
  if (!profile?.managedConsumer) {
    if (sources !== undefined) throw failure("STEAM_API_PROFILE_REQUIRED", "This managed Steam API assembly needs an exact compatibility profile.");
    return { symbols, consumers: [] };
  }
  const expected = validateConsumerProfile(profile.managedConsumer);
  if (!Array.isArray(sources) || sources.length !== 1) {
    throw failure("STEAM_API_CONSUMER_REQUIRED", "The selected Steam API profile needs its exact managed assembly.");
  }
  const consumer = await readConsumer(sources[0], expected, signal);
  // Only declarations in the verified wrapper are lazy. Other requirements
  // retain their full export check instead of inheriting this profile.
  const remaining = symbols.filter(symbol => !consumer.declaredSymbols.includes(symbol));
  return { symbols: unique([...consumer.requiredSymbols, ...remaining]),
    consumers: [{ assemblySha256: consumer.assemblySha256, assemblyBytes: consumer.assemblyBytes,
      assemblyName: consumer.assemblyName, assemblyVersion: consumer.assemblyVersion,
      declaredSymbolCount: consumer.declaredSymbols.length, requiredSymbolCount: consumer.requiredSymbols.length }] };
}

module.exports = { MAX_BYTES, importIdentity, validateConsumerProfile, resolveManagedRequirement };

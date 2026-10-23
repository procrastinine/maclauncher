import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Bundled from "../src/modules/shared/runtime/bundled-native.js";
import Supplementals from "./native-supplementals.cjs";
import { validateEffectSources } from "./reshade-effect-sources.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Effect and capability changes reuse the sealed native payload. No native checkout, build
// directory, signing operation or source archive generation is involved.
export function stageReShadeEffects({
  resourceRoot = path.join(repository, "src/resources/native-runtimes"),
  declarationPath = path.join(repository, "src/modules/shared/reshade/distribution-supplementals.json"),
  effectsDirectory = path.join(repository, "src/modules/shared/reshade/effects"),
  features,
  effectSources,
  dependencies = {}
} = {}) {
  const originalDeclarationBytes = Bundled.readRegular(declarationPath, Bundled.LIMITS.manifestBytes).bytes;
  const declarations = JSON.parse(originalDeclarationBytes);
  if (!Array.isArray(declarations) || declarations.length !== 1 || declarations[0].id !== "reshade") {
    throw new Error("Effects staging requires one sealed ReShade declaration.");
  }
  const original = declarations[0];
  const verify = (root, declaration) => Supplementals.verifySupplementals({
    resourceRoot: root, arch: "arm64", maximumMacOS: declaration.minimumMacOS, items: [declaration], dependencies
  });
  verify(resourceRoot, original);
  const originalRoot = path.join(resourceRoot, original.directoryRelative);
  const manifest = JSON.parse(Bundled.readRegular(path.join(originalRoot, original.manifestRelative), Bundled.LIMITS.manifestBytes).bytes);
  if (manifest.version !== original.version || manifest.minimumMacOS !== original.minimumMacOS ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceHash || "") || !Array.isArray(manifest.sourcePins) || !manifest.sourcePins.length ||
      !isDeepStrictEqual(manifest.files, original.files.filter(file => file.path !== original.manifestRelative))) {
    throw new Error("Sealed ReShade manifest and declaration disagree.");
  }
  if (features !== undefined) {
    if (!features || typeof features !== "object" || Array.isArray(features)) throw new Error("Graphics features must be an object.");
    Supplementals.validatePublicMetadata(features);
    manifest.features = structuredClone(features);
  }
  const inputs = new Map();
  for (const file of manifest.files.filter(file => !file.path.startsWith("effects/"))) {
    const read = Bundled.readRegular(path.join(originalRoot, file.path), file.size);
    if (read.sha256 !== file.sha256 || read.size !== file.size || read.mode !== file.mode) throw new Error("Sealed ReShade payload changed during staging.");
    inputs.set(file.path, { bytes: read.bytes, record: { ...file } });
  }
  const effectNames = fs.readdirSync(effectsDirectory).sort();
  if (!effectNames.length || effectNames.length > 64 || effectNames.some(name => !/^[A-Za-z0-9_-]+\.fxh?$/.test(name))) {
    throw new Error("ReShade effects must be bounded .fx or .fxh files.");
  }
  for (const name of effectNames) {
    const { bytes } = Bundled.readRegular(path.join(effectsDirectory, name), 1024 * 1024);
    const relative = `effects/${name}`;
    if (!bytes.length) throw new Error("ReShade effect files must not be empty.");
    inputs.set(relative, { bytes, record: { path: relative, size: bytes.length, mode: 0o644, sha256: digest(bytes) } });
  }
  const sources = effectSources ?? manifest.effectSources ?? [];
  const notices = [...original.notices.filter(notice => !notice.path.startsWith("effects/")),
    ...validateEffectSources(sources, [...inputs.values()].map(input => input.record))];
  if (effectSources !== undefined || manifest.effectSources !== undefined) manifest.effectSources = structuredClone(sources);
  // Identity includes preserved provenance and every output byte. Repeating an
  // unchanged effects update is idempotent, even after its declaration is active.
  const { version: _version, files: _files, ...provenance } = manifest;
  const payloadHash = digest(Buffer.concat([
    Buffer.from("reshade-effects-v1\0" + JSON.stringify(provenance) + "\0" + JSON.stringify(notices) + "\0"),
    ...[...inputs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, input]) =>
      [Buffer.from(name + "\0" + JSON.stringify(input.record) + "\0"), input.bytes])
  ]));
  const releaseVersion = original.version.split("-")[0];
  const version = `${releaseVersion}-${manifest.sourceHash.slice(0, 8)}-${payloadHash.slice(0, 8)}`;
  const directoryRelative = `reshade/${version}/universal`;
  const files = [...inputs.values()].map(input => input.record).sort((a, b) => a.path.localeCompare(b.path));
  const manifestBytes = Buffer.from(JSON.stringify({ ...manifest, version, files }, null, 2) + "\n");
  const manifestRecord = { path: original.manifestRelative, sha256: digest(manifestBytes), size: manifestBytes.length, mode: 0o644 };
  const declaration = { ...original, version, directoryRelative, manifestSha256: manifestRecord.sha256, files: [...files, manifestRecord], notices };
  Supplementals.validateDeclaration(declaration);
  inputs.set(original.manifestRelative, { bytes: manifestBytes, record: manifestRecord });
  const temporary = fs.mkdtempSync(path.join(resourceRoot, ".reshade-effects-"));
  const temporaryPayload = path.join(temporary, directoryRelative);
  const destination = path.join(resourceRoot, directoryRelative);
  let declarationTemporary;
  try {
    for (const [relative, input] of inputs) {
      const output = path.join(temporaryPayload, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, input.bytes, { flag: "wx", mode: input.record.mode });
      fs.chmodSync(output, input.record.mode);
    }
    verify(temporary, declaration);
    if (fs.existsSync(destination)) verify(resourceRoot, declaration);
    else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(temporaryPayload, destination);
    }
    if (!fs.readFileSync(declarationPath).equals(originalDeclarationBytes)) throw new Error("ReShade declaration changed during staging; the active declaration was preserved.");
    declarationTemporary = `${declarationPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(declarationTemporary, JSON.stringify([declaration], null, 2) + "\n", { flag: "wx", mode: 0o644 });
    fs.renameSync(declarationTemporary, declarationPath);
    return { destination, version, previousVersion: original.version, minimumMacOS: original.minimumMacOS,
      files: declaration.files.length, sourceHash: manifest.sourceHash, nativePayloadPreserved: true };
  } finally {
    if (declarationTemporary && fs.existsSync(declarationTemporary)) fs.unlinkSync(declarationTemporary);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const { DEFAULT_LIMITS, parseMarshal, resolveNode, replaceStrings, sha256 } = require("./marshal");

const SCRIPT_LIMITS = Object.freeze({ maxScriptBytes: 8 * 1024 * 1024, maxTotalSourceBytes: 128 * 1024 * 1024 });
const EXPORT_FORMAT = "maclauncher-rgss-scripts-v1";

function readBoundedFile(filePath, maxBytes = DEFAULT_LIMITS.maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SCRIPT_LIMITS.maxTotalSourceBytes) throw new Error("Invalid file byte limit.");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Input must be a regular file within the byte limit.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Input changed while reading.");
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error("Input grew while reading.");
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Input changed while reading.");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function scriptLimitsFor(options = {}) {
  const limits = { ...SCRIPT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > limits[key]) throw new Error(`Invalid script limit: ${key}.`);
    limits[key] = options[key];
  }
  return limits;
}

function decodeScripts(input, options = {}) {
  const graph = parseMarshal(input, { ...options, allowMultiple: false });
  const root = resolveNode(graph, graph.streams[0].root);
  if (root.kind !== "array") throw new Error("Scripts archive must contain an Array.");
  const limits = scriptLimitsFor(options);
  let total = 0;
  const inflated = new Map();
  const scripts = root.items.map((recordId, index) => {
    const record = resolveNode(graph, recordId);
    if (record.kind !== "array" || record.items.length !== 3) throw new Error(`Unsupported Scripts record at index ${index}: expected [id, name, compressed source].`);
    const id = resolveNode(graph, record.items[0]);
    const name = resolveNode(graph, record.items[1]);
    const payload = resolveNode(graph, record.items[2]);
    if (id.kind !== "integer" || name.kind !== "string" || payload.kind !== "string") throw new Error(`Invalid Scripts record at index ${index}.`);
    let source = inflated.get(payload.id);
    if (!source) {
      try {
        const result = zlib.inflateSync(payload.bytes, { maxOutputLength: limits.maxScriptBytes, info: true });
        if (result.engine.bytesWritten !== payload.bytes.length) throw new Error("Trailing data after zlib stream.");
        source = result.buffer;
      } catch (error) {
        throw new Error(`Cannot inflate Scripts record ${index}: ${error.message}`);
      }
      inflated.set(payload.id, source);
    }
    total += source.length;
    if (total > limits.maxTotalSourceBytes) throw new Error("Scripts exceed total source byte limit.");
    return { index, id: id.value, recordNode: record.id, nameNode: name.id, payloadNode: payload.id, name: name.bytes, source, compressed: payload.bytes };
  });
  return { graph, scripts };
}

function sourceFileName(script) {
  return `${String(script.index).padStart(6, "0")}-${script.id}.rb`;
}

function exportScripts({ sourcePath, outputDir, engineVariant = null, runtime = null, options = {} }) {
  const original = readBoundedFile(sourcePath);
  const { scripts } = decodeScripts(original, options);
  const manifest = {
    format: EXPORT_FORMAT,
    parserFormat: "ruby-marshal-4.8-static-v1",
    engineVariant,
    runtime,
    sourcePath: path.resolve(sourcePath),
    sourceFileName: path.basename(sourcePath),
    exportedAt: new Date().toISOString(),
    originalFile: "original.bin",
    originalSha256: sha256(original),
    scripts: scripts.map(script => ({
      index: script.index,
      id: script.id,
      file: sourceFileName(script),
      nameBase64: script.name.toString("base64"),
      namePreview: script.name.subarray(0, 256).toString("utf8"),
      recordNode: script.recordNode,
      nameNode: script.nameNode,
      payloadNode: script.payloadNode,
      compressedSha256: sha256(script.compressed),
      sourceSha256: sha256(script.source),
      sourceByteLength: script.source.length
    }))
  };
  // An export is an immutable baseline plus editable byte-for-byte Ruby files.
  // Never erase an existing working directory (including the user's edits).
  fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(outputDir, "original.bin"), original, { flag: "wx", mode: 0o600 });
    for (const script of scripts) fs.writeFileSync(path.join(outputDir, sourceFileName(script)), script.source, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }
  return { outputDir, scriptCount: scripts.length, sourceByteLength: scripts.reduce((n, script) => n + script.source.length, 0), originalSha256: manifest.originalSha256 };
}

function repackScripts({ exportDir, options = {} }) {
  const manifest = JSON.parse(readBoundedFile(path.join(exportDir, "manifest.json")).toString("utf8"));
  if (manifest?.format !== EXPORT_FORMAT || manifest.originalFile !== "original.bin" || !Array.isArray(manifest.scripts)) throw new Error("Unsupported Scripts manifest.");
  const original = readBoundedFile(path.join(exportDir, "original.bin"));
  if (sha256(original) !== manifest.originalSha256) throw new Error("Original Scripts baseline hash mismatch.");
  const { graph, scripts } = decodeScripts(original, options);
  if (manifest.scripts.length !== scripts.length) throw new Error("Manifest changed the script count.");
  const limits = scriptLimitsFor(options);
  const sources = new Map();
  const replacements = new Map();
  let changedCount = 0;
  let total = 0;
  for (const script of scripts) {
    const record = manifest.scripts[script.index];
    if (!record || record.index !== script.index || record.id !== script.id || record.file !== sourceFileName(script) ||
        record.nameBase64 !== script.name.toString("base64") || record.compressedSha256 !== sha256(script.compressed) ||
        record.sourceSha256 !== sha256(script.source) || record.payloadNode !== script.payloadNode ||
        record.recordNode !== script.recordNode || record.nameNode !== script.nameNode || record.sourceByteLength !== script.source.length) {
      throw new Error(`Scripts manifest record ${script.index} does not match its baseline.`);
    }
    const source = readBoundedFile(path.join(exportDir, record.file), limits.maxScriptBytes);
    total += source.length;
    if (total > limits.maxTotalSourceBytes) throw new Error("Edited Scripts exceed total source byte limit.");
    const shared = sources.get(script.payloadNode);
    if (shared && !shared.equals(source)) throw new Error("Shared compressed script payloads must be edited consistently in every linked record.");
    sources.set(script.payloadNode, source);
    if (!source.equals(script.source)) {
      changedCount++;
      if (!replacements.has(script.payloadNode)) replacements.set(script.payloadNode, zlib.deflateSync(source));
    }
  }
  const buffer = replaceStrings(graph, replacements);
  const checked = decodeScripts(buffer, options);
  // Surgical replacement must preserve the original record layout and links.
  if (checked.graph.nodes.length !== graph.nodes.length || JSON.stringify(checked.graph.streams[0].objects) !== JSON.stringify(graph.streams[0].objects) ||
      JSON.stringify(checked.graph.streams[0].symbols) !== JSON.stringify(graph.streams[0].symbols)) throw new Error("Scripts graph identity changed during repack.");
  for (const script of checked.scripts) {
    const before = scripts[script.index];
    if (script.id !== before.id || script.payloadNode !== before.payloadNode || !script.name.equals(before.name) || !script.source.equals(sources.get(script.payloadNode))) {
      throw new Error("Scripts validation failed after repack.");
    }
  }
  return { buffer, changedCount, scriptCount: scripts.length, originalSha256: sha256(original), outputSha256: sha256(buffer), engineVariant: manifest.engineVariant, runtime: manifest.runtime };
}

function writeRepackedScripts({ exportDir, outputPath, options = {} }) {
  const result = repackScripts({ exportDir, options });
  // A new output only. Installing a bundle into a game is a separate opt-in.
  fs.writeFileSync(outputPath, result.buffer, { flag: "wx", mode: 0o600 });
  const { buffer, ...report } = result;
  return { ...report, outputPath };
}

function uniqueExportName() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

module.exports = { SCRIPT_LIMITS, EXPORT_FORMAT, readBoundedFile, decodeScripts, exportScripts, repackScripts, writeRepackedScripts, uniqueExportName };

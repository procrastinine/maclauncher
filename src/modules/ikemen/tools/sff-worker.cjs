const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { encodePngBitmap } = require("../../../core/icon-utils");
const { PIN, inspectRuntime } = require("./sff-manager");
const LIMITS = { files: 1024, fileBytes: 128 * 1024 ** 2, sourceBytes: 512 * 1024 ** 2,
  sprites: 20000, batchBytes: 64 * 1024 ** 2, pixelBytes: 512 * 1024 ** 2, metadataBytes: 16 * 1024 ** 2 };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function exportSprites(request) {
  const { installDir, sourceRoot, files, outputRoot } = request;
  inspectRuntime({ runtimePath: path.join(installDir, "sff.wasm"), runtimeVersion: PIN.version, upstreamRevision: PIN.upstreamRevision });
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) throw new Error("SFF source file count exceeds the supported limit.");
  // Only the reviewed Go runtime sees this context. It has no Node require,
  // filesystem, process or network host; its ordinary browser stubs stay inert.
  const sandbox = vm.createContext({ crypto: { getRandomValues: bytes => crypto.webcrypto.getRandomValues(bytes) },
    performance: { now: () => performance.now() }, TextEncoder, TextDecoder, console,
    Uint8Array, Uint8ClampedArray, ArrayBuffer, DataView, WebAssembly,
    setTimeout, clearTimeout }, { codeGeneration: { strings: false, wasm: true } });
  vm.runInContext(fs.readFileSync(path.join(installDir, "wasm_exec.js"), "utf8"), sandbox, { timeout: 5000 });
  const go = new sandbox.Go();
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(installDir, "sff.wasm")), go.importObject);
  const running = go.run(instance); running.catch(error => { console.error(error); process.exitCode = 1; });
  const api = sandbox.OpenKakutouSff;
  if (!api?.load || !api?.resolveSprites) throw new Error("SFF Tools did not register its sprite reader.");
  let sourceBytes = 0, pixelBytes = 0, spriteCount = 0, exported = 0;
  const results = [];
  for (const [fileIndex, relative] of files.entries()) {
    const record = { source: relative, exported: 0, failures: [] }; results.push(record);
    try {
      const input = path.resolve(sourceRoot, relative);
      if (!input.startsWith(sourceRoot + path.sep) || fs.realpathSync(input) !== input || !/\.sff$/i.test(input)) throw new Error("SFF input escaped the game directory.");
      const stat = fs.lstatSync(input);
      if (!stat.isFile() || stat.size > LIMITS.fileBytes || (sourceBytes += stat.size) > LIMITS.sourceBytes) throw new Error("SFF input exceeds the 128 MiB file or 512 MiB total limit.");
      const bytes = fs.readFileSync(input); record.sha256 = digest(bytes);
      const loaded = api.load(bytes);
      if (loaded?.error) throw new Error(loaded.error);
      if (typeof loaded?.spriteGroups !== "string" || Buffer.byteLength(loaded.spriteGroups) > LIMITS.metadataBytes) throw new Error("SFF metadata exceeds the supported limit.");
      const groups = JSON.parse(loaded.spriteGroups);
      if (!Array.isArray(groups)) throw new Error("SFF Tools returned invalid sprite metadata.");
      const sprites = groups.flatMap(group => Array.isArray(group.sprites) ? group.sprites : []);
      if ((spriteCount += sprites.length) > LIMITS.sprites) throw new Error("SFF export exceeds the 20,000 sprite limit.");
      const folder = path.join(outputRoot, String(fileIndex).padStart(4, "0") + "-" + path.basename(relative).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80));
      fs.mkdirSync(folder); record.directory = path.basename(folder);
      fs.writeFileSync(path.join(folder, "sprites.json"), JSON.stringify(groups, null, 2));
      const seen = new Set(); let batch = [], batchBytes = 0;
      function flush() {
        if (!batch.length) return;
        const decoded = api.resolveSprites(bytes, batch.map(item => [item.sprite.group, item.sprite.image]), null);
        if (!Array.isArray(decoded) || decoded.length !== batch.length) throw new Error("SFF Tools could not decode the requested sprite batch.");
        for (const [index, item] of batch.entries()) {
          const pixels = decoded[index], { sprite, ordinal } = item;
          try {
            if (pixels?.error) throw new Error(pixels.error);
            if (!Number.isInteger(pixels?.width) || !Number.isInteger(pixels?.height) || pixels.width !== sprite.width || pixels.height !== sprite.height ||
              !ArrayBuffer.isView(pixels?.pixels) || pixels.pixels.byteLength !== pixels.width * pixels.height * 4)
              throw new Error("SFF Tools returned inconsistent pixel dimensions.");
            const png = encodePngBitmap({ width: pixels.width, height: pixels.height, buffer: Buffer.from(pixels.pixels) }, { maximumDimension: 4096 });
            if (!png) throw new Error("SFF sprite exceeds the supported PNG dimensions.");
            fs.writeFileSync(path.join(folder, `${ordinal}-${sprite.group}-${sprite.image}.png`), png); record.exported++; exported++;
          } catch (error) { record.failures.push({ sprite: [sprite.group, sprite.image], error: error.message }); }
        }
        batch = []; batchBytes = 0;
      }
      for (const [ordinal, sprite] of sprites.entries()) {
        const size = sprite.width * sprite.height * 4, key = sprite.group + ":" + sprite.image;
        const invalid = ![sprite.group, sprite.image, sprite.width, sprite.height].every(Number.isInteger) ? "Invalid sprite identity or dimensions."
          : sprite.width < 1 || sprite.height < 1 ? "Empty sprite has no pixel image."
          : sprite.width > 4096 || sprite.height > 4096 || size > LIMITS.batchBytes ? "Sprite exceeds 4,096 pixels per axis or the 64 MiB batch limit."
          : pixelBytes + size > LIMITS.pixelBytes ? "The 512 MiB requested-pixel limit was reached."
          : seen.has(key) ? "Duplicate sprite identity cannot be resolved independently by this decoder." : null;
        if (invalid) { record.failures.push({ sprite: [sprite.group, sprite.image], error: invalid }); continue; }
        seen.add(key); pixelBytes += size;
        if (batch.length >= 16 || batchBytes + size > LIMITS.batchBytes) flush();
        batch.push({ sprite, ordinal }); batchBytes += size;
      }
      flush();
      if (digest(fs.readFileSync(input)) !== record.sha256) throw new Error("Original SFF changed during export.");
    } catch (error) { record.failures.push({ error: error.message }); }
  }
  const result = { toolVersion: PIN.version, sourceRevision: PIN.upstreamRevision, files: results.length, sprites: exported,
    failed: results.reduce((sum, item) => sum + item.failures.length, 0), sourceBytes, requestedPixelBytes: pixelBytes, results };
  fs.writeFileSync(path.join(outputRoot, "sprites-export.json"), JSON.stringify(result, null, 2));
  if (!exported) throw new Error("No sprites were exported. See sprites-export.json for individual format errors.");
  return result;
}
if (require.main === module) {
  exportSprites(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))).then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
}
module.exports = { exportSprites, LIMITS };

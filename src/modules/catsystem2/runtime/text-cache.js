const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const B = require("../../shared/runtime/bundled-native"), Text = require("./coretext-raster");
const LIMITS = Object.freeze({ records: 512, bytes: 256 * 1024 * 1024, metadataBytes: 4096 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), SHA = /^[a-f0-9]{64}$/;

/** Shared helper, original fonts in memory, and only derived per-game pixels. */
async function createTextCache({ cacheRoot, helper, arch = process.arch, signal, render = Text.renderText, spawnChild } = {}) {
  if (!path.isAbsolute(cacheRoot || "") || !["arm64", "x64"].includes(arch) || helper?.version !== Text.VERSION || helper.protocolVersion !== 1 ||
      !SHA.test(helper.binarySha256 || "") || typeof helper.systemVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(helper.systemVersion))
    throw new Error("A per-game cache and exact CoreText version/platform are required.");
  B.realDirectory(cacheRoot, { create: true }); const root = await fs.promises.realpath(cacheRoot), directory = path.join(root, "font-text"); B.realDirectory(directory, { create: true });
  const pending = new Map(); let commits = Promise.resolve();
  async function footprint() {
    const names = await fs.promises.readdir(directory); if (names.length > LIMITS.records * 2 + 32) throw new Error("The text raster cache exceeds its entry limit.");
    let bytes = 0, records = 0;
    for (const name of names) {
      if (name.startsWith(".partial-")) continue;
      if (!/^[a-f0-9]{64}\.(?:rgba|json)$/.test(name)) throw new Error("The text raster cache contains an unexpected path.");
      const stat = await fs.promises.lstat(path.join(directory, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Text raster cache files must be regular.");
      bytes += stat.size; if (name.endsWith(".json")) records++;
    }
    return { bytes, records };
  }
  async function get(font, request) {
    signal?.throwIfAborted(); Text.validateRequest(request, font);
    const { text, ...layout } = request;
    const identity = { schemaVersion: 1, rendererVersion: helper.version, rendererSha256: helper.binarySha256, arch, systemVersion: helper.systemVersion,
      fontSha256: digest(font), textSha256: digest(Buffer.from(text, "utf8")), layout };
    const key = digest(Buffer.from(JSON.stringify(identity))), metadata = path.join(directory, key + ".json");
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      async function existing() {
        const record = JSON.parse(B.readRegular(metadata, LIMITS.metadataBytes).bytes);
        if (JSON.stringify(record.identity) !== JSON.stringify(identity) || !SHA.test(record.rgbaSha256 || "")) throw new Error("The text raster cache identity changed.");
        const file = path.join(directory, record.rgbaSha256 + ".rgba"), pixels = B.readRegular(file, Text.LIMITS.pixels * 4);
        if (pixels.sha256 !== record.rgbaSha256 || pixels.size !== request.width * request.height * 4) throw new Error("The text raster cache pixels changed.");
        const receipt = Buffer.from(JSON.stringify(record.receipt)), header = Buffer.alloc(12); header.write("CSTR"); header.writeUInt32LE(receipt.length, 4); header.writeUInt32LE(pixels.size, 8);
        const raster = Text.inspectRaster(Buffer.concat([header, receipt, pixels.bytes]), request);
        return Object.freeze({ ...raster, key, rgbaPath: file, rgbaSha256: pixels.sha256, offsetX: 0, offsetY: 0, frameId: 0, reused: true });
      }
      try { return await existing(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const raster = await render(helper, request, font, { signal, ...(spawnChild ? { spawnChild } : {}) }); signal?.throwIfAborted();
      const { rgba, rendererVersion, ...receipt } = raster; void rendererVersion;
      if (!Buffer.isBuffer(rgba)) throw new Error("The text renderer returned no pixels.");
      const packetHeader = Buffer.alloc(12), packetReceipt = Buffer.from(JSON.stringify(receipt)); packetHeader.write("CSTR"); packetHeader.writeUInt32LE(packetReceipt.length, 4); packetHeader.writeUInt32LE(rgba.length, 8);
      Text.inspectRaster(Buffer.concat([packetHeader, packetReceipt, rgba]), request);
      const record = { identity, receipt, rgbaSha256: digest(rgba) }, content = Buffer.from(JSON.stringify(record) + "\n");
      if (content.length > LIMITS.metadataBytes) throw new Error("The text raster cache metadata exceeds its limit.");
      const commit = commits.then(async () => {
        const used = await footprint(); if (used.records >= LIMITS.records || used.bytes + rgba.length + content.length > LIMITS.bytes) throw new Error("The text raster cache exceeds its storage limit.");
        const file = path.join(directory, record.rgbaSha256 + ".rgba"), partial = path.join(directory, ".partial-" + crypto.randomUUID());
        try {
          await fs.promises.writeFile(partial + ".rgba", rgba, { flag: "wx", mode: 0o600 });
          await fs.promises.writeFile(partial + ".json", content, { flag: "wx", mode: 0o600 }); signal?.throwIfAborted();
          for (const [from, to] of [[partial + ".rgba", file], [partial + ".json", metadata]])
            try { await fs.promises.link(from, to); } catch (error) { if (error.code !== "EEXIST") throw error; }
          const result = await existing(); signal?.throwIfAborted(); return Object.freeze({ ...result, reused: false });
        } finally { await fs.promises.rm(partial + ".rgba", { force: true }); await fs.promises.rm(partial + ".json", { force: true }); }
      });
      commits = commit.catch(() => {}); return commit;
    })();
    pending.set(key, operation); try { return await operation; } finally { pending.delete(key); }
  }
  return { root, get };
}

module.exports = { LIMITS, createTextCache };

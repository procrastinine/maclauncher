const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const B = require("../../shared/runtime/bundled-native"), Archive = require("../archive"), HG = require("../image-hg3"), Viewport = require("../viewport");
const Plane = require("./plane-compositor");
const LIMITS = Object.freeze({ frames: 256, bytes: 512 * 1024 * 1024 });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const locatedKey = located => located.sourcePath ? `${located.observation?.path}:${located.observation?.identity}` : `${located.archive.path}:${located.entry.index}`;

/** Only decoded frames are cached; original archives are read in place. */
async function createImageCache({ cacheRoot, registry, signal, decodeRaster } = {}) {
  if (!registry?.locate || !registry?.read || !path.isAbsolute(cacheRoot || "")) throw new Error("Bounded CatSystem2 image-cache services are required.");
  B.realDirectory(cacheRoot, { create: true }); const root = await fs.promises.realpath(cacheRoot), colors = path.join(root, "colors"), planes = path.join(root, "planes"); B.realDirectory(colors, { create: true }); B.realDirectory(planes, { create: true });
  const frames = new Map(), pending = new Map(), metadata = new Map(), metadataPending = new Map(), derived = new Map(); let memoryBytes = 0;
  const verify = located => typeof registry.verify === "function" ? registry.verify(located) : Archive.verifyArchive(located.archive, { signal });
  async function retain(key, create) {
    signal?.throwIfAborted(); if (frames.has(key)) return frames.get(key); if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const frame = await create(); signal?.throwIfAborted();
      if (frames.size >= LIMITS.frames || memoryBytes + frame.rgba.length > LIMITS.bytes) throw new Error("CatSystem2 decoded images exceed their cache limit.");
      memoryBytes += frame.rgba.length; frames.set(key, frame); return frame;
    })(); pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  async function loadFrame(name, frameId) {
    if (!Number.isInteger(frameId) || frameId < 0 || frameId > 0xffffffff) throw new Error("A bounded authored HG-3 frame ID is required.");
    const located = await registry.locate("image", name); await verify(located);
    const key = `${locatedKey(located)}:${frameId}:${HG.VERSION}`;
    return retain(key, async () => {
      const bytes = await registry.read("image", name, { maximumBytes: HG.LIMITS.inputBytes }), frame = await HG.decodeFrame(bytes, { frameId }, { signal, decodeRaster });
      return Object.freeze({ ...frame, ...await Viewport.writeFrame(root, frame, { signal }) });
    });
  }
  async function describeFrame(name, frameId, { allowMissing = false } = {}) {
    signal?.throwIfAborted();
    if (!Number.isInteger(frameId) || frameId < 0 || frameId > 0xffffffff || typeof allowMissing !== "boolean") throw new Error("A bounded authored HG-3 frame ID is required.");
    let located; try { located = await registry.locate("image", name); } catch (error) { if (allowMissing && error.code === "CAT_RESOURCE_ABSENT") return null; throw error; }
    await verify(located);
    const key = `${locatedKey(located)}:${HG.VERSION}`;
    let info = metadata.get(key);
    if (!info) {
      let work = metadataPending.get(key);
      if (!work) {
        if (metadata.size + metadataPending.size >= LIMITS.frames) throw new Error("CatSystem2 image metadata exceeds its cache limit.");
        work = (async () => {
          const bytes = await registry.read("image", name, { maximumBytes: HG.LIMITS.inputBytes }); signal?.throwIfAborted();
          const inspected = HG.inspectHg3(bytes); metadata.set(key, inspected); return inspected;
        })(); metadataPending.set(key, work);
      }
      try { info = await work; } finally { metadataPending.delete(key); }
    }
    if (allowMissing && !info.frames.some(frame => frame.frameId === frameId)) return null;
    return HG.selectFrame(info, { frameId });
  }
  async function writePixels(directory, frame) {
    const rgba = frame.rgba, sha256 = digest(rgba), file = path.join(directory, sha256 + ".rgba"), partial = path.join(directory, ".partial-" + crypto.randomUUID());
    const check = () => {
      const before = fs.lstatSync(file, { bigint: true }), current = B.readRegular(file, HG.LIMITS.frameBytes), after = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || current.size !== rgba.length || current.sha256 !== sha256 || fileIdentity(before) !== fileIdentity(after))
        throw new Error("The FES graphics cache was modified.");
      derived.set(file, fileIdentity(after));
    };
    try { check(); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await fs.promises.writeFile(partial, rgba, { flag: "wx", mode: 0o600 }); signal?.throwIfAborted();
        try { await fs.promises.link(partial, file); } catch (failure) { if (failure.code !== "EEXIST") throw failure; } check();
      } finally { await fs.promises.rm(partial, { force: true }); }
    }
    return Object.freeze({ ...frame, rgbaPath: file, rgbaSha256: sha256 });
  }
  function verifyPixels(frame) {
    const observed = fs.lstatSync(frame.rgbaPath, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink() || observed.size !== BigInt(frame.rgba.length)) throw new Error("The FES graphics cache was modified.");
    if (derived.get(frame.rgbaPath) !== fileIdentity(observed)) {
      const current = B.readRegular(frame.rgbaPath, HG.LIMITS.frameBytes), after = fs.lstatSync(frame.rgbaPath, { bigint: true });
      if (current.size !== frame.rgba.length || current.sha256 !== frame.rgbaSha256 || fileIdentity(observed) !== fileIdentity(after)) throw new Error("The FES graphics cache was modified.");
      derived.set(frame.rgbaPath, fileIdentity(after));
    }
    return frame;
  }
  async function composePlane(request) {
    signal?.throwIfAborted(); Plane.validatePlane(request);
    const key = digest(Buffer.from(JSON.stringify({ version: Plane.VERSION, width: request.width, height: request.height,
      layers: request.layers.map(({ rgba, ...layer }) => ({ ...layer, rgbaSha256: digest(rgba) })) })));
    return verifyPixels(await retain(`plane:${key}`, async () => writePixels(planes, Plane.composePlane(request, { signal }))));
  }
  async function colorFrame(width, height, argb) {
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= HG.LIMITS.dimension) || width * height > HG.LIMITS.pixels ||
        !Number.isInteger(argb) || argb < 0 || argb > 0xffffffff) throw new Error("A bounded FES color frame is required.");
    return verifyPixels(await retain(`color:${width}:${height}:${argb}`, async () => {
      const rgba = Buffer.alloc(width * height * 4), pixel = [argb >>> 16 & 255, argb >>> 8 & 255, argb & 255, argb >>> 24];
      for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(pixel, offset);
      return writePixels(colors, { rgba, width, height, canvasWidth: width, canvasHeight: height, offsetX: 0, offsetY: 0, frameId: 0,
        format: "FES-COLOR", generatorVersion: "1.0.0-ml1" });
    }));
  }
  function close() { frames.clear(); metadata.clear(); derived.clear(); memoryBytes = 0; }
  return { root, frames, loadFrame, describeFrame, composePlane, colorFrame, close };
}
module.exports = { LIMITS, createImageCache };

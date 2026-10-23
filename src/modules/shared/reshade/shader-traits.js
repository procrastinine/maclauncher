// Descriptive metadata only. Original provider parsers remain authoritative for
// executable shader syntax, resources, parameters and supported input stages.
const fs = require("node:fs");
const VERSION = 3, MAX_FILE_BYTES = 8 * 1024 * 1024, fileCache = new Map();
const RGB = new Set(["RGB", "MAIN", "NATIVE", "LINEAR", "SIGMOID", "PREKERNEL", "POSTKERNEL", "SCALED", "PREOUTPUT", "OUTPUT"]);
const FRAME = new Set([...RGB, "LUMA"]);
function expression(text, sizes, hooked, axis) {
  const stack = [];
  for (const token of text.trim().split(/\s+/)) {
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) stack.push({ value: Number(token), degree: 0 });
    else if (/^[A-Za-z_][A-Za-z0-9_]*\.[wh]$/.test(token)) {
      const [name, dimension] = token.split(".");
      // Cross-axis and display-dependent expressions need actual runtime sizes.
      if (dimension !== axis || name === "OUTPUT") return null;
      const value = sizes.get(name === "HOOKED" ? hooked : name);
      if (!value) return null;
      stack.push({ value: value[axis === "w" ? "x" : "y"], degree: 1 });
    } else if (["*", "/"].includes(token) && stack.length >= 2) {
      const b = stack.pop(), a = stack.pop(); stack.push(token === "*"
        ? { value: a.value * b.value, degree: a.degree + b.degree }
        : { value: a.value / b.value, degree: a.degree - b.degree });
    } else return null;
    if (stack.length > 64 || stack.some(({ value, degree }) => !Number.isFinite(value) || !Number.isFinite(degree))) return null;
  }
  // A relative output extent must remain linear in one input dimension.
  // Numeric-only WIDTH/HEIGHT expressions instead describe absolute pixels.
  return stack.length === 1 && stack[0].degree === 1 && stack[0].value >= 1 / 16 && stack[0].value <= 16 ? stack[0].value : null;
}
function inspect(text, format) {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) return { category: "effects", neural: false };
  const descriptions = [], stages = new Set(), sizes = new Map([...FRAME].map(name => [name, {x: 1, y: 1}]));
  let block = null, outputScale = null, unknownGeometry = false, requiresVideoPlanes = false;
  let conditionalGeometry = false, displayDependentGeometry = false, sizingDeclared = false;
  const outputHooks = new Set();
  const flush = () => {
    if (!block?.hooks.length) return;
    const frameOutput = block.hooks.some(hook => FRAME.has(hook) && (!block.save || block.save === hook));
    // Feature textures and reconstructed chroma planes do not resize the frame.
    // Only a published full-frame hook contributes a resolution contract.
    if (frameOutput && (block.width || block.height)) {
      sizingDeclared = true;
      if (block.when) { conditionalGeometry = true;unknownGeometry = true; }
      if (/\bOUTPUT\.[wh]\b/.test([block.width, block.height, block.when].filter(Boolean).join(" "))) {
        displayDependentGeometry = true;unknownGeometry = true;
      }
    }
    if (block.binds.some(name => /^(?:LUMA|CHROMA|CHROMA_SCALED)$/.test(name)) ||
        !block.hooks.some(name => RGB.has(name)) && block.hooks.some(name => /^(?:LUMA|CHROMA|CHROMA_SCALED)$/.test(name))) requiresVideoPlanes = true;
    for (const hooked of block.hooks) {
      stages.add(hooked);
      const initial = sizes.get(hooked);
      const x = block.width ? expression(block.width, sizes, hooked, "w") : initial?.x;
      const y = block.height ? expression(block.height, sizes, hooked, "h") : initial?.y;
      const target = block.save || hooked;
      const publishes = !block.save || block.save === hooked;
      if (publishes && FRAME.has(hooked) && (block.width || block.height)) {
        outputHooks.add(hooked);
        if (outputHooks.size > 1) unknownGeometry = true;
      }
      if (x == null || y == null || block.when && !publishes) {
        sizes.delete(target);
        if (publishes && FRAME.has(hooked)) { unknownGeometry = true;outputScale = null; }
        continue;
      }
      sizes.set(target, {x, y});
      if (publishes && FRAME.has(hooked) && (block.width || block.height)) outputScale = {x, y};
    }
  };
  if (format === "libplacebo") {
    let inHeader = false;
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*\/\/!\s*(\w+)(?:\s+(.*?))?\s*$/.exec(line);
      if (!match) { if (line.trim() && !line.trim().startsWith("//")) inHeader = false; continue; }
      if (!inHeader) { flush(); block = {hooks: [], binds: []}; inHeader = true; }
      const [, key, raw = ""] = match, value = raw.trim();
      if (key === "HOOK") block.hooks.push(value);
      if (key === "BIND") block.binds.push(value);
      if (key === "SAVE") block.save = value;
      if (key === "WIDTH") block.width = value;
      if (key === "HEIGHT") block.height = value;
      if (key === "WHEN") block.when = value;
      if (key === "DESC" && value && descriptions.length < 32) descriptions.push(value.slice(0, 512));
    }
    flush();
  }
  const description = descriptions[0] || "", declarations = descriptions.join(" ");
  const neural = /(?:^|[^a-z0-9])(?:CNN|FSRCNNX?|ArtCNN|NNEDI3?|neural|convolution(?:al)?)(?=$|[^a-z0-9])|Anime4K.*CNN/i.test(declarations);
  const scale = !unknownGeometry && outputScale && (outputScale.x !== 1 || outputScale.y !== 1) ? outputScale : null;
  const category = outputScale && (outputScale.x > 1 || outputScale.y > 1) ? "upscaling" : outputScale && (outputScale.x < 1 || outputScale.y < 1) ? "downscaling" :
    sizingDeclared && unknownGeometry ? "scaling" :
    [...stages].some(stage => /^CHROMA(?:_SCALED)?$/.test(stage)) && ![...stages].some(stage => FRAME.has(stage)) ? "chroma" :
    /\b(?:denoise|deband|restore|restoration|deblur)\b/i.test(declarations) ? "restoration" :
    /\b(?:CRT|scanlines?|phosphor)\b/i.test(declarations) ? "crt" :
    /\b(?:color|colour|tone|gamma|vibrance)\b/i.test(declarations) ? "color" : "effects";
  return { category, neural, ...(description ? {description} : {}),
    ...(scale ? {outputScale: scale} : {}), ...(conditionalGeometry ? {conditionalGeometry: true} : {}),
    ...(displayDependentGeometry ? {displayDependentGeometry: true} : {}), ...(sizingDeclared && unknownGeometry ? {unresolvedGeometry: true} : {}),
    ...(format === "libplacebo" ? {stages: [...stages], requiresVideoPlanes,
      inputPlanes: requiresVideoPlanes ? ["luma", "chroma"] : ["rgb"], rgbCompatible: !requiresVideoPlanes && [...stages].some(stage => RGB.has(stage)), geometryKnown: !unknownGeometry} : {}) };
}
const groups = { upscaling: "Imported upscalers", downscaling: "Imported downscalers", scaling: "Resolution-dependent shaders", chroma: "Chroma reconstruction", restoration: "Imported restoration", crt: "Imported CRT", color: "Imported color", effects: "Imported filters" };
function analyzeFile(file, format = "libplacebo") {
  const canonical = fs.realpathSync(file), stat = fs.statSync(canonical);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Shader metadata requires a source file up to 8 MiB.");
  const stamp = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
  const identity = `${VERSION}:${format}:${stamp(stat)}`, cached = fileCache.get(canonical);
  if (cached?.identity === identity) return cached.analysis;
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    if (stamp(fs.fstatSync(fd)) !== stamp(stat)) throw new Error("The shader source changed while reading metadata.");
    bytes = Buffer.alloc(stat.size);let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error("The shader source changed while reading metadata.");offset += read;
    }
    if (stamp(fs.fstatSync(fd)) !== stamp(stat)) throw new Error("The shader source changed while reading metadata.");
  } finally { fs.closeSync(fd); }
  const analysis = { parserVersion: VERSION, sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs, sourceCtimeMs: stat.ctimeMs,
    traits: inspect(bytes.toString("utf8"), format) };
  if (fileCache.size >= 4096) fileCache.delete(fileCache.keys().next().value);
  fileCache.set(canonical, { identity, analysis });return analysis;
}
module.exports = { VERSION, inspect, analyzeFile, group: traits => groups[traits?.category] || groups.effects };

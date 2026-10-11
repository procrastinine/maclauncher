const path = require("node:path"), { spawn } = require("node:child_process");
const VERSION = "1.0.0-ml1", LIMITS = Object.freeze({ fontBytes: 16 * 1024 * 1024, textBytes: 8192, jsonBytes: 65536, pixels: 4 * 1024 * 1024, dimension: 8192, timeoutMs: 10000 });
const FIELDS = ["width", "height", "fontSize", "margin", "color", "lineSpacing", "letterSpacing", "shadow", "alignment", "text"];
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

function validateRequest(request, font) {
  if (!request || typeof request !== "object" || Object.keys(request).length !== FIELDS.length || Object.keys(request).some(key => !FIELDS.includes(key)) ||
      !integer(request.width, 1, LIMITS.dimension) || !integer(request.height, 1, LIMITS.dimension) || request.width * request.height > LIMITS.pixels ||
      !integer(request.fontSize, 1, 256) || !integer(request.lineSpacing, -128, 256) || !integer(request.letterSpacing, -128, 256) ||
      !Array.isArray(request.margin) || request.margin.length !== 4 || request.margin.some(value => !integer(value, 0, LIMITS.dimension)) ||
      request.margin[0] + request.margin[2] >= request.width || request.margin[1] + request.margin[3] >= request.height ||
      !Array.isArray(request.color) || request.color.length !== 3 || request.color.some(value => !integer(value, 0, 255)) || request.shadow !== "none" || request.alignment !== "left" ||
      typeof request.text !== "string" || /[\x00-\x09\x0b-\x1f\x7f\\]/.test(request.text) || !Buffer.isBuffer(font) || font.length < 12 || font.length > LIMITS.fontBytes)
    throw new Error("This bounded font/text raster request is unsupported.");
  const text = Buffer.from(request.text, "utf8");
  if (text.length > LIMITS.textBytes || text.toString("utf8") !== request.text) throw new Error("Text raster input is not bounded UTF-8.");
  const { text: unused, ...layout } = request; void unused;
  const record = { ...layout, fontBytes: font.length, textBytes: text.length }, json = Buffer.from(JSON.stringify(record));
  if (json.length > LIMITS.jsonBytes) throw new Error("Text raster layout exceeds its limit.");
  return { json, text };
}
function encodeRequest(request, font) {
  const { json, text } = validateRequest(request, font), header = Buffer.alloc(8); header.write("CSTR"); header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json, font, text]);
}

function inspectRaster(bytes, request) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 14 || bytes.length > LIMITS.pixels * 4 + LIMITS.jsonBytes + 12 || bytes.toString("ascii", 0, 4) !== "CSTR")
    throw new Error("The font raster protocol is invalid.");
  const length = bytes.readUInt32LE(4), size = bytes.readUInt32LE(8);
  if (!length || length > LIMITS.jsonBytes || size !== request.width * request.height * 4 || bytes.length !== 12 + length + size) throw new Error("Text raster output lengths disagree.");
  let receipt; try { receipt = JSON.parse(bytes.subarray(12, 12 + length)); } catch { throw new Error("The text raster receipt is invalid."); }
  const fields = ["schemaVersion", "protocolVersion", "width", "height", "rgbaBytes", "glyphs", "lines", "consumedUtf16", "clipped", "endX", "endY"];
  if (!receipt || Object.keys(receipt).length !== fields.length || Object.keys(receipt).some(name => !fields.includes(name)) ||
      receipt.schemaVersion !== 1 || receipt.protocolVersion !== "CSTR1" || receipt.width !== request.width || receipt.height !== request.height || receipt.rgbaBytes !== size ||
      !integer(receipt.glyphs, 0, LIMITS.textBytes) || !integer(receipt.lines, 0, LIMITS.textBytes + 1) || !integer(receipt.consumedUtf16, 0, request.text.length) ||
      typeof receipt.clipped !== "boolean" || ![receipt.endX, receipt.endY].every(value => Number.isFinite(value) && Math.abs(value) <= 4 * LIMITS.dimension))
    throw new Error("Text raster geometry or metrics disagree.");
  return Object.freeze({ ...receipt, rgba: bytes.subarray(12 + length), rendererVersion: VERSION });
}

function renderText(helper, request, font, { signal, spawnChild = spawn } = {}) {
  if (helper?.version !== VERSION || helper.protocolVersion !== 1 || !path.isAbsolute(helper.executablePath || ""))
    return Promise.reject(new Error("An exact included CoreText renderer is required."));
  let input; try { signal?.throwIfAborted(); input = encodeRequest(request, font); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawnChild(helper.executablePath, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, ...(signal ? { signal } : {}) });
    let size = 0, failure = null; const chunks = [];
    const timer = setTimeout(() => { failure ||= new Error("Text rasterization timed out."); child.kill("SIGKILL"); }, LIMITS.timeoutMs);
    child.on("error", () => { failure ||= new Error("The text renderer could not start."); });
    child.stdin.on("error", () => { failure ||= new Error("Font/text raster input was interrupted."); child.kill("SIGKILL"); });
    child.stderr.resume(); child.stdout.on("data", chunk => {
      size += chunk.length; if (size > request.width * request.height * 4 + LIMITS.jsonBytes + 12) { failure ||= new Error("Text raster output exceeds its limit."); child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (signal?.aborted) { try { signal.throwIfAborted(); } catch (error) { return reject(error); } }
      if (failure) return reject(failure); if (code !== 0) return reject(new Error("The authored font or text layout is corrupt or unsupported."));
      try { signal?.throwIfAborted(); resolve(inspectRaster(Buffer.concat(chunks), request)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

module.exports = { VERSION, LIMITS, validateRequest, encodeRequest, inspectRaster, renderText };

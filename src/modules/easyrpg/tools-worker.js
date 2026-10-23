const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const HEADERS = { ldb: "LcfDataBase", lmt: "LcfMapTree", lmu: "LcfMapUnit" };
function validateHeader(bytes, format) {
  const header = HEADERS[format];
  if (!header || bytes[0] !== header.length || bytes.subarray(1, header.length + 1).toString("ascii") !== header)
    throw new Error("An LCF file has an invalid database, map tree or map header.");
}

function readInput(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error("An LCF input is empty, linked or exceeds its size limit.");
    const buffer = Buffer.alloc(stat.size);
    if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) throw new Error("An LCF input changed during export.");
    return buffer;
  } finally { fs.closeSync(fd); }
}

function stringsIn(value, limits, visitor) {
  let nodes = 0;
  function visit(current, key = "", depth = 0) {
    if (++nodes > limits.nodes || depth > limits.depth) throw new Error("The LCF data exceeds supported structure limits.");
    if (typeof current === "string") { if (current) visitor(current, key); }
    else if (current && typeof current === "object" && !(current instanceof Uint8Array)) {
      for (const [name, child] of Object.entries(current)) {
        if (name !== "_unknown") visit(child, key ? `${key}.${name}` : name, depth + 1);
      }
    }
  }
  visit(value);
}

async function run(data) {
  const { root, files, staging, mode, limits } = data;
  const codec = await import("rpgrt");
  const encodings = await import("rpgrt/encoding");
  const databaseFile = files.find(name => /^RPG_RT\.ldb$/i.test(name));
  if (!databaseFile) throw new Error("The project database is missing.");
  const databaseBytes = readInput(path.join(root, databaseFile), limits.fileBytes);
  validateHeader(databaseBytes, "ldb");
  let engine = data.engine, raw;
  if (!engine) {
    for (const candidate of ["2k", "2k3"]) {
      const decoded = codec.decodeDatabase(databaseBytes, { engine: candidate });
      if (Buffer.from(codec.encodeDatabase(decoded, { engine: candidate })).equals(databaseBytes)) {
        engine = candidate; raw = decoded; break;
      }
    }
    if (!engine) throw new Error("The RPG Maker edition could not be determined. Select an engine mode in Runtime Settings and retry.");
  }
  if (!raw) raw = codec.decodeDatabase(databaseBytes, { engine });
  let encoding = data.encoding;
  if (!encoding) {
    const chunks = [];
    let bytes = 0;
    stringsIn(raw, limits, text => {
      if (bytes >= 65536) return;
      const sample = Buffer.from(text, "latin1").subarray(0, 65536 - bytes);
      chunks.push(sample); bytes += sample.length;
    });
    encoding = encodings.detectEncoding(Buffer.concat(chunks)) || "windows-1252";
  }
  const options = { engine, transcoder: encodings.createTranscoder(encoding) };
  const decoders = { ldb: codec.decodeDatabase, lmt: codec.decodeTreeMap, lmu: codec.decodeMapUnit };
  let outputBytes = 0, inputBytes = 0, textCount = 0;
  const warnings = [];
  for (const [index, name] of files.entries()) {
    if (path.basename(name) !== name || !/^(?:RPG_RT\.(?:ldb|lmt)|Map\d+\.lmu)$/i.test(name)) throw new Error("Invalid LCF input filename.");
    const format = path.extname(name).slice(1).toLowerCase();
    const bytes = name === databaseFile ? databaseBytes : readInput(path.join(root, name), limits.fileBytes);
    validateHeader(bytes, format);
    inputBytes += bytes.length;
    if (inputBytes > limits.inputBytes) throw new Error("LCF project data exceeds the 128 MB export limit.");
    const decoded = decoders[format](bytes, { ...options, onWarning: message => { if (warnings.length < 32) warnings.push(`${name}: ${message}`); } });
    let content = decoded;
    if (mode === "text") {
      content = [];
      stringsIn(decoded, limits, (text, location) => {
        if (++textCount > limits.textUnits) throw new Error("The project exceeds the supported text export count.");
        content.push({ path: location, text });
      });
    }
    let nodes = 0;
    const json = JSON.stringify({ format, source: name, engine, encoding, data: content }, (_key, value) => {
      if (++nodes > limits.nodes) throw new Error("The LCF data exceeds supported structure limits.");
      return value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value;
    }, 2) + "\n";
    const size = Buffer.byteLength(json);
    outputBytes += size;
    if (size > limits.fileOutputBytes || outputBytes > limits.outputBytes) throw new Error("The LCF export exceeds its output size limit.");
    fs.writeFileSync(path.join(staging, `${name}.json`), json, { flag: "wx" });
    parentPort.postMessage({ type: "progress", current: index + 1 });
  }
  return { fileCount: files.length, textCount: mode === "text" ? textCount : null, engine, encoding, bytes: outputBytes, warnings };
}

run(workerData).then(result => parentPort.postMessage({ type: "complete", result }),
  error => parentPort.postMessage({ type: "error", message: error.message || "LCF export failed." }));

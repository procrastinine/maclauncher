const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");

const VARIABLE_COUNT = 65536;
const MAX_AIN_BYTES = 64 * 1024 * 1024;
const PROFILE = "xsystem35-2.20.0-variable-symbols-v1";

function readAinVariableNames(file) {
  if (!file || !fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 20 || stat.size > MAX_AIN_BYTES) return [];
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 3).toString("ascii") !== "AIN") return [];
  for (let index = 4; index < bytes.length; index++) bytes[index] = (bytes[index] << 2 | bytes[index] >> 6) & 255;
  let offset = 8;
  const available = count => { if (count < 0 || offset > bytes.length - count) throw new Error("Truncated System39 variable metadata."); };
  const uint = maximum => {
    available(4);
    const value = bytes.readUInt32LE(offset);
    offset += 4;
    if (value > maximum) throw new Error("System39 variable metadata exceeds its limit.");
    return value;
  };
  const string = () => {
    const end = bytes.indexOf(0, offset);
    if (end < offset || end - offset > 65536) throw new Error("Invalid System39 variable name.");
    const value = new TextDecoder("shift_jis").decode(bytes.subarray(offset, end));
    offset = end + 1;
    return value;
  };
  const tag = value => { available(4); return bytes.subarray(offset, offset + 4).toString("ascii") === value; };
  try {
    if (!tag("HEL0")) return [];
    offset += 8;
    const dllCount = uint(1024);
    for (let dll = 0; dll < dllCount; dll++) {
      string();
      const functions = uint(65536);
      for (let fn = 0; fn < functions; fn++) {
        string();
        const argumentsCount = uint(4096);
        available(argumentsCount * 4);
        offset += argumentsCount * 4;
      }
    }
    if (tag("FUNC")) {
      offset += 8;
      const functions = uint(65536);
      for (let fn = 0; fn < functions; fn++) { string(); available(6); offset += 6; }
    }
    if (!tag("VARI")) return [];
    offset += 8;
    const count = uint(VARIABLE_COUNT);
    return Array.from({ length: count }, string);
  } catch {
    // AIN metadata improves labels only. Bounded numeric variable access is
    // still available when an optional name table cannot be read safely.
    return [];
  }
}

function variableNames(known = []) {
  const used = new Set();
  return Array.from({ length: VARIABLE_COUNT }, (_, index) => {
    const preferred = typeof known[index] === "string" && known[index] && !known[index].includes("\0") ? known[index] : `VAR${index}`;
    let name = preferred;
    if (used.has(name)) name = `[variable ${index}]`;
    while (used.has(name)) name += "_";
    used.add(name);
    return name;
  });
}

function encodeSymbols(names) {
  if (!Array.isArray(names) || !names.length || names.length > VARIABLE_COUNT ||
      names.some(name => typeof name !== "string" || !name || name.includes("\0") || Buffer.byteLength(name) > 65536)) throw new Error("Invalid debugger variable labels.");
  const labels = Buffer.from(names.join("\0") + "\0", "utf8");
  if (labels.length > MAX_AIN_BYTES) throw new Error("Debugger variable labels exceed their limit.");
  const header = Buffer.alloc(24);
  header.write("DSYM", 0, "ascii");
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(1, 8);
  header.write("VARI", 12, "ascii");
  header.writeUInt32LE(12 + labels.length, 16);
  header.writeUInt32LE(names.length, 20);
  return Buffer.concat([header, labels]);
}

// Retail games generally have no .symbols file. Supply only variable labels
// beside asset links, rather than recompiling scripts or writing the original
// archive. The native debugger patches its in-memory scenario copy only.
function prepareDebugDirectory({ entry, userDataDir, scenarioPath }) {
  if (!entry?.gameId || !userDataDir || !path.isAbsolute(scenarioPath || "")) throw new Error("Import this game before opening live variables.");
  const rootDir = fs.realpathSync(entry.contentRootDir);
  if (path.dirname(fs.realpathSync(scenarioPath)) !== rootDir) throw new Error("Scenario archive is outside the imported game.");
  const names = fs.readdirSync(rootDir);
  if (names.length > 20000) throw new Error("Game directory contains too many files for debug tools.");
  const ainName = names.find(name => /^System39\.ain$/i.test(name));
  const labels = variableNames(readAinVariableNames(ainName && path.join(rootDir, ainName)));
  const content = encodeSymbols(labels);
  const symbolsName = path.basename(scenarioPath) + ".symbols";
  const symbolSha256 = crypto.createHash("sha256").update(content).digest("hex");
  const identity = crypto.createHash("sha256").update(JSON.stringify({ rootDir, symbolsName, symbolSha256, names })).digest("hex").slice(0, 20);
  const directory = path.join(GameData.resolveGameModuleDir(userDataDir, entry.gameId, "alicesoft"), "debug", PROFILE, identity);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (name === symbolsName) continue;
    const source = path.join(rootDir, name), target = path.join(directory, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== source) throw new Error("Debugger asset link changed.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.symlinkSync(source, target);
    }
  }
  const symbolsPath = path.join(directory, symbolsName);
  if (fs.existsSync(symbolsPath)) {
    if (!fs.lstatSync(symbolsPath).isFile() || fs.lstatSync(symbolsPath).isSymbolicLink() ||
        !fs.readFileSync(symbolsPath).equals(content)) throw new Error("Debugger variable metadata changed.");
  } else fs.writeFileSync(symbolsPath, content, { flag: "wx", mode: 0o600 });
  return { directory, symbolsPath, symbolSha256, labels, profile: PROFILE, originalRoot: rootDir };
}

module.exports = { VARIABLE_COUNT, PROFILE, readAinVariableNames, variableNames, encodeSymbols, prepareDebugDirectory };

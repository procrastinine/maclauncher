const fs = require("node:fs");
const path = require("node:path");

const GAME_ID = /^[a-z][a-z0-9_-]{0,63}(?::[a-z0-9][a-z0-9_-]{0,127})?$/i;

function readPart(file, length, tail = false) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return Buffer.alloc(0);
    const size = Math.min(stat.size, length), buffer = Buffer.alloc(size), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buffer, 0, size, tail ? stat.size - size : 0); } finally { fs.closeSync(fd); }
    return buffer;
  } catch { return Buffer.alloc(0); }
}

function gobIntroArchive(file) {
  const header = readPart(file, 2);
  if (header.length !== 2) return false;
  const count = header.readUInt16LE(0);
  if (!count || count > 4096) return false;
  const table = readPart(file, 2 + count * 22);
  if (table.length !== 2 + count * 22) return false;
  for (let i = 0; i < count; i++) {
    const bytes = table.subarray(2 + i * 22, 15 + i * 22), zero = bytes.indexOf(0);
    if (zero !== -1 && bytes.subarray(0, zero).toString("ascii").toLowerCase() === "intro.tot") return true;
  }
  return false;
}

function detectDirectory(root, selectedPath) {
  let files;
  try { files = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  if (files.length > 4096) return null;
  const names = new Map(files.filter(file => file.isFile()).map(file => [file.name.toLowerCase(), file.name]));
  const file = name => names.has(name) ? path.join(root, names.get(name)) : null;
  const has = name => names.has(name);
  const all = (...list) => list.every(has);
  const archiveToolCount = [...names.keys()].filter(name => /\.(?:stk|itk|ltk|jtk|pak)$/.test(name)).length;
  const evidence = (engine, markers, gameId = null) => ({ sourceKind: engine, detectionMarkers: markers,
    archiveToolCount, ...(gameId ? { gameId } : {}) });

  const markers = [...names.keys()].filter(name => name.endsWith(".scummvm"));
  const selectedName = selectedPath && path.basename(selectedPath).toLowerCase();
  if (markers.length === 1 || markers.includes(selectedName)) {
    const marker = markers.includes(selectedName) ? selectedName : markers[0];
    const content = readPart(file(marker), 1025);
    if (content.length <= 1024) {
      const gameId = content.toString("utf8").replace(/^\uFEFF/, "").trim();
      if (!gameId || GAME_ID.test(gameId)) return evidence("ScummVM game marker", [names.get(marker)], gameId || null);
    }
  }
  if (all("sky.dsk", "sky.dnr") && readPart(file("sky.dnr"), 4).length >= 3) return evidence("Sky", [names.get("sky.dsk"), names.get("sky.dnr")]);
  if (has("queen.1") && readPart(file("queen.1"), 16).length === 16) return evidence("Queen", [names.get("queen.1")]);
  if (all("logdir", "picdir", "viewdir", "snddir", "words.tok", "object") && [...names.keys()].some(name => /^vol\.\d+$/.test(name))) {
    return evidence("AGI", ["logdir", "picdir", "viewdir", "snddir", "words.tok", "object"]);
  }
  if (has("resource.map") && [...names.keys()].some(name => /^resource\.\d{3}$/.test(name)) ||
      has("resmap.000") && has("ressci.000")) return evidence("SCI", has("resource.map") ? ["resource.map"] : ["resmap.000", "ressci.000"]);
  for (const name of names.keys()) {
    if (name.endsWith(".000") && has(name.slice(0, -4) + ".001")) {
      const index = readPart(file(name), 4), dataName = name.slice(0, -4) + ".001", archive = readPart(file(dataName), 4);
      const decode = (bytes, xor) => Buffer.from(bytes.map(value => value ^ xor)).toString("ascii");
      if ([0, 0x69].some(xor => /^(?:RNAM|DROO|MAXS)$/.test(decode(index, xor)) && decode(archive, xor) === "LECF")) {
        // A dropped auxiliary EXE is not the game merely because these files
        // happen to be beside it. SCUMM data and runner normally share a stem.
        if (selectedName?.endsWith(".exe") && selectedName.slice(0, -4) !== name.slice(0, -4)) continue;
        return evidence("SCUMM", [names.get(name), names.get(dataName)]);
      }
    }
    if (/^00\.lfl$/.test(name) && (has("01.lfl") || has("disk01.lec"))) return evidence("SCUMM", [names.get(name)]);
    if (name.endsWith(".mhk") && readPart(file(name), 4).toString("ascii") === "MHWK") return evidence("Mohawk", [names.get(name)]);
    if (name.endsWith(".dcp") && readPart(file(name), 8).toString("hex") === "addec0de4a554e4b") return evidence("Wintermute", [names.get(name)]);
    if (/\.(?:ags|dat)$/.test(name) && (readPart(file(name), 32).subarray(0, 4).toString("ascii") === "CLIB" ||
        readPart(file(name), 32).toString("ascii").startsWith("Adventure Creator Game File"))) return evidence("Adventure Game Studio", [names.get(name)]);
    if (name.endsWith(".exe") && readPart(file(name), 32, true).includes(Buffer.from("CLIB\x01\x02\x03\x04SIGE", "binary"))) return evidence("Adventure Game Studio", [names.get(name)]);
    if (/\.(?:dxr|dcr|cct|cxt|dir)$/.test(name)) {
      const header = readPart(file(name), 12);
      if (["RIFF", "RIFX", "XFIR"].includes(header.toString("ascii", 0, 4)) && /^(?:MV93|FGDM|FCDR|MC95|39VM|MDGF|RDCF|59CM)$/.test(header.toString("ascii", 8, 12))) return evidence("Director", [names.get(name)]);
    }
  }
  if (all("grim.tab") && [...names.keys()].some(name => name.endsWith(".lab") && readPart(file(name), 4).toString("ascii") === "LABN")) return evidence("Grim", [names.get("grim.tab")]);
  if (has("monkey4.tab") && [...names.keys()].some(name => name.endsWith(".m4b"))) return evidence("Grim", [names.get("monkey4.tab")]);
  if (all("dw.scn", "dw.gra")) return evidence("Tinsel", [names.get("dw.scn"), names.get("dw.gra")]);
  if (all("toon.dat", "toon.toc")) return evidence("Toon", [names.get("toon.dat"), names.get("toon.toc")]);
  if (all("startup.mix", "mode.mix") && (has("blade.exe") || has("bladerunner.exe"))) return evidence("Blade Runner", [names.get("startup.mix"), names.get("mode.mix")]);
  if (has("intro.stk") && (has("intro.tot") || gobIntroArchive(file("intro.stk")))) return evidence("Gob", [names.get("intro.stk")]);
  return null;
}

function detectGame(context) {
  const root = context.rootDir;
  const roots = context.isAppBundle
    ? [path.join(root, "game"), path.join(root, "Contents", "Resources", "game"), path.join(root, "Contents", "Resources")]
    : [root, path.join(root, "game"), path.join(root, "data")];
  const matches = [];
  for (const candidate of roots) {
    const moduleData = detectDirectory(candidate, context.inputPath);
    if (moduleData) matches.push({ candidate, moduleData });
  }
  // An import selects one game directory, never an arbitrary game in a collection.
  if (matches.length !== 1) return null;
  const { candidate, moduleData } = matches[0];
  return { moduleId: "scummvm", engine: "scummvm", runtimeId: "scummvm", gamePath: candidate,
    contentRootDir: candidate, name: path.basename(root, context.isAppBundle ? ".app" : undefined), moduleData };
}

module.exports = { detectGame, detectDirectory, readPart, GAME_ID };

const fs = require("node:fs");
const path = require("node:path");
const { detectSystem3Version, detectSystem35Version } = require("./version");
const { inspectSystem4 } = require("./system4-detect");

function validScenario(filePath, ald) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 256) return false;
    const data = Buffer.alloc(6);
    fd = fs.openSync(filePath, "r");
    if (fs.readSync(fd, data, 0, 6, 0) !== 6) return false;
    if (ald) {
      const offsets = data.readUIntLE(0, 3) * 256;
      const linksEnd = data.readUIntLE(3, 3) * 256;
      return offsets > 0 && linksEnd > offsets && linksEnd <= stat.size;
    }
    const linkSector = data.readUInt16LE(0);
    const dataSector = data.readUInt16LE(2);
    return linkSector > 0 && dataSector > linkSector && (dataSector - 1) * 256 <= stat.size;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inspectRoot(rootDir) {
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return null; }
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const system4 = inspectSystem4(rootDir, files);
  if (system4) return system4;
  // Malformed System 4 projects must never fall back to System 3.x.
  if (files.some(name => /^(System40|AliceStart)\.ini$/i.test(name))) return null;
  const scenario = files.find(name => /SA\.ALD$/i.test(name) && validScenario(path.join(rootDir, name), true));
  if (scenario) {
    const scenarioPath = path.join(rootDir, scenario);
    return { generation: "system35", scenarioPath, ...detectSystem35Version(rootDir, files, scenarioPath), recommendedRuntime: "xsystem35", compatibility: "Runs System 3.5–3.9 ALD scenario data with xsystem35." };
  }
  const adisk = files.find(name => /^ADISK\.DAT$/i.test(name));
  const graphics = files.some(name => /^A(G00|CG)\.DAT$/i.test(name));
  if (adisk && validScenario(path.join(rootDir, adisk), false) && (graphics || files.some(name => /^system3\.ini$/i.test(name)))) {
    const scenarioPath = path.join(rootDir, adisk);
    return { generation: "system3", scenarioPath, ...detectSystem3Version(rootDir, files, scenarioPath), recommendedRuntime: "system3", compatibility: "Runs System 1–3 data. Translated games may need an explicit game ID." };
  }
  return null;
}

function detectGame(context) {
  if (!context?.rootDir) return null;
  const inputPath = context.inputPath || context.rootDir;
  if (context.stat?.isFile?.() && !/\.(exe|ald|dat|ini|ain)$/i.test(inputPath)) return null;
  const roots = context.isAppBundle
    ? ["Contents/Resources/game", "Contents/Resources"].map(relative => path.join(context.rootDir, relative))
    : [context.rootDir];
  for (const rootDir of roots) {
    const info = inspectRoot(rootDir);
    if (!info) continue;
    return {
      engine: "alicesoft", gameType: "scripted", gamePath: inputPath, contentRootDir: rootDir,
      name: context.isAppBundle ? path.basename(context.rootDir, ".app") : path.basename(rootDir),
      moduleData: info
    };
  }
  return null;
}

module.exports = { detectGame, inspectRoot };

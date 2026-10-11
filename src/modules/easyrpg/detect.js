const fs = require("node:fs");
const path = require("node:path");

const HEADERS = { database: "LcfDataBase", mapTree: "LcfMapTree" };

function regularFiles(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile()); }
  catch { return []; }
}

function hasLcfHeader(file, signature) {
  let descriptor;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < signature.length + 1) return false;
    descriptor = fs.openSync(file, "r");
    const header = Buffer.alloc(signature.length + 1);
    return fs.readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header[0] === signature.length && header.subarray(1).toString("ascii") === signature;
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function inspectProject(root) {
  const files = regularFiles(root);
  const find = name => files.find(item => item.name.toLowerCase() === name.toLowerCase())?.name;
  const database = find("RPG_RT.ldb"), mapTree = find("RPG_RT.lmt");
  if (!database || !mapTree || !hasLcfHeader(path.join(root, database), HEADERS.database) ||
    !hasLcfHeader(path.join(root, mapTree), HEADERS.mapTree)) return null;
  const iniName = find("RPG_RT.ini");
  let title = null, encoding = null;
  if (iniName) {
    try {
      const file = path.join(root, iniName);
      if (fs.statSync(file).size <= 65536) {
        const text = fs.readFileSync(file, "utf8");
        const section = name => text.match(new RegExp(`^\\s*\\[${name}\\]\\s*\\r?\\n([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, "im"))?.[1] || "";
        const value = (sectionName, key) => section(sectionName).match(new RegExp(`^\\s*${key}\\s*=\\s*([^\\r\\n]*)`, "im"))?.[1]?.trim();
        const name = value("RPG_RT", "GameTitle");
        if (name && !name.includes("\uFFFD") && !/[\x00-\x1F]/.test(name)) title = name;
        encoding = value("EasyRPG", "Encoding") || null;
      }
    } catch {}
  }
  return { database, mapTree, title, encoding,
    mapCount: files.filter(item => /^Map\d+\.lmu$/i.test(item.name)).length,
    hasDynRpg: Boolean(find("DynRPG.dll")),
    hasEasyRpgConfig: Boolean(find("EasyRPG.ini")) };
}

function candidateRoots(context) {
  const root = context?.rootDir;
  if (!root) return [];
  if (!context.isAppBundle) return [root];
  return [root, path.join(root, "Contents", "Resources"), path.join(root, "Contents", "Resources", "game")];
}

function detectGame(context) {
  for (const root of candidateRoots(context)) {
    const project = inspectProject(root);
    if (!project) continue;
    return { engine: "easyrpg", gameType: "easyrpg", gamePath: root, contentRootDir: root,
      name: project.title || path.basename(context.isAppBundle ? context.rootDir : root, ".app"),
      moduleData: { sourceKind: "RPG Maker 2000/2003", database: project.database, mapTree: project.mapTree,
        mapCount: project.mapCount, encoding: project.encoding, hasDynRpg: project.hasDynRpg,
        detectedVersion: "2000 / 2003", detectedVersionSource: "LCF database and map tree headers",
        detectedVersionConfidence: "signature" } };
  }
  return null;
}

module.exports = { HEADERS, hasLcfHeader, inspectProject, detectGame };

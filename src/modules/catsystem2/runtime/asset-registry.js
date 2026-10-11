const path = require("node:path");
const { child, value, memberPath } = require("../startup");
const Encoding = require("../encoding");
const Archive = require("../archive");

const LIMITS = Object.freeze({ types: 100, archivesPerType: 256, listBytes: 64 * 1024, nameBytes: 1024 });

function parseRegistry(document) {
  const section = child(document, "INT"), types = new Map();
  for (const node of section.children) {
    if (!/^int\d{2}$/.test(node.name)) continue;
    const name = value(node, "name"), archive = value(node, "int"), extension = value(node, "ext"), directory = value(node, "dir");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || types.has(name) || types.size >= LIMITS.types || !/^[A-Za-z0-9]{1,16}$/.test(extension))
      throw new Error("CatSystem2 asset registry contains an unsupported or repeated type.");
    const logicalArchive = memberPath(archive.replaceAll("\\", "/")), logicalDirectory = memberPath(directory.replaceAll("\\", "/"));
    if (!/\.(?:int|lst)$/i.test(logicalArchive)) throw new Error("CatSystem2 asset registry requires an INT archive or archive list.");
    const voice = node.attributes?.voice ?? null;
    if (voice != null && !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(voice)) throw new Error("Unsupported CatSystem2 voice identifier.");
    types.set(name, { name, archive: logicalArchive, extension, directory: logicalDirectory, voice });
  }
  return types;
}

function archiveList(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.listBytes) throw new Error("CatSystem2 archive list exceeds its read limit.");
  const text = Encoding.decode(bytes), result = [], seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("//")) continue;
    const name = memberPath(line.replaceAll("\\", "/"));
    if (!/\.int$/i.test(name) || result.length >= LIMITS.archivesPerType || seen.has(name.toLowerCase())) throw new Error("CatSystem2 archive list is unsupported or repeated.");
    seen.add(name.toLowerCase()); result.push(name);
  }
  if (!result.length) throw new Error("CatSystem2 archive list is empty."); return result;
}

/** Resolve authored resource types against original, validated archive indexes. */
function createRegistry({ document, assets, archiveIndex, language = null } = {}) {
  if (!assets?.read || typeof archiveIndex !== "function") throw new Error("A bounded CatSystem2 asset reader and archive resolver are required.");
  const types = parseRegistry(document), lists = new Map();
  const expand = name => {
    if (typeof name !== "string" || !name || name.length > LIMITS.nameBytes) throw new Error("CatSystem2 resource name exceeds its limit.");
    if (name.includes("%LANG%")) { if (!/^[a-z]{2,8}$/.test(language || "")) throw new Error("CatSystem2 language resource selection is unavailable."); name = name.replaceAll("%LANG%", language); }
    if (/%[A-Za-z_]+%/.test(name)) throw new Error("Unsupported CatSystem2 resource variable."); return memberPath(name);
  };
  async function archivesFor(type) {
    if (!types.has(type)) throw new Error(`CatSystem2 resource type ${type} is absent.`);
    if (!lists.has(type)) {
      const declaration = types.get(type), promise = (async () => {
        const names = /\.lst$/i.test(declaration.archive) ? archiveList(await assets.read(declaration.archive, { maximumBytes: LIMITS.listBytes })) : [declaration.archive];
        return Promise.all(names.map(name => archiveIndex(name)));
      })();
      lists.set(type, promise); promise.catch(() => lists.delete(type));
    }
    return lists.get(type);
  }
  async function locate(type, source) {
    const declaration = types.get(type); if (!declaration) throw new Error(`CatSystem2 resource type ${type} is absent.`);
    let name = expand(source); if (!path.posix.extname(name)) name += `.${declaration.extension}`;
    const sourcePath = memberPath(`${declaration.directory}/${name}`);
    if (typeof assets.exists === "function" && await assets.exists(sourcePath)) {
      const observation = typeof assets.observe === "function" ? await assets.observe(sourcePath) : null;
      return Object.freeze({ sourcePath, observation });
    }
    const archives = await archivesFor(type), found = [];
    for (const archive of archives) for (const entry of archive.entries) if (entry.name.toLowerCase() === name.toLowerCase()) found.push({ archive, entry });
    if (found.length !== 1) {
      const error = new Error(`CatSystem2 ${type} resource is ${found.length ? "ambiguous" : "absent"}.`);
      error.code = found.length ? "CAT_RESOURCE_AMBIGUOUS" : "CAT_RESOURCE_ABSENT"; throw error;
    }
    return found[0];
  }
  async function read(type, source, options) {
    const located = await locate(type, source);
    const bytes = await assets.read(located.sourcePath || `${path.basename(located.archive.path)}/${located.entry.name}`, options);
    if (located.sourcePath && located.observation) await verify(located); return bytes;
  }
  async function verify(located) {
    if (!located?.sourcePath) return Archive.verifyArchive(located?.archive);
    if (!located.observation || typeof assets.observe !== "function") throw new Error("An observed original loose asset is required.");
    const current = await assets.observe(located.sourcePath);
    if (current.path !== located.observation.path || current.identity !== located.observation.identity) throw new Error("The original loose resource changed.");
    return true;
  }
  return { types, expand, archivesFor, locate, read, verify };
}
module.exports = { LIMITS, parseRegistry, archiveList, createRegistry };

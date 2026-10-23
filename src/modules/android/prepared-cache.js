const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const { withCatalogLock } = require("./catalog-lock");

const generationKey = name => /^([a-f0-9]{64})(?:-[a-f0-9]{16})?$/.exec(name)?.[1];
const generationPaths = directory => fs.readdirSync(directory, { withFileTypes: true })
  .filter(item => item.isDirectory() && !item.isSymbolicLink() && generationKey(item.name))
  .map(item => path.join(directory, item.name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const handoffs = new WeakMap();
function leaseChange(root, operation) {
  const used = fs.statSync(root);
  try { return operation(); }
  finally { fs.utimesSync(root, used.atime, used.mtime); }
}

// Selection, publication, retention and eviction share one kernel owner per
// package. Different packages prepare in parallel; independent launch workers
// reuse published conversions. No lock survives into a game's execution.
function locked(directory, operation) {
  Writable.assertOwnDirectory(path.dirname(directory), directory, { create: false });
  return withCatalogLock(path.join(path.dirname(directory), ".preparation.lock"), operation);
}

function retainLocked(root) {
  Writable.assertOwnDirectory(path.dirname(root), root, { create: false });
  const file = path.join(root, ".use-" + process.pid + "-" + crypto.randomBytes(12).toString("hex"));
  leaseChange(root, () => fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 }));
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const directory = path.dirname(root);
    if (!fs.existsSync(directory)) return;
    await locked(directory, async () => {
      if (fs.existsSync(root)) leaseChange(root, () => fs.rmSync(file, { force: true }));
      await pruneLocked(directory, generationPaths(directory)[0]);
    });
  };
}

async function retainPrepared(prepared) {
  const handoff = handoffs.get(prepared);
  if (handoff) { handoffs.delete(prepared); return handoff; }
  return locked(path.dirname(prepared.root), () => retainLocked(prepared.root));
}

/** Retain a supervisor-published generation for an authenticated installed
 * package. A service reply cannot turn an arbitrary path into a source grant. */
async function retainPackageSource(userDataDir,record){
  const profile=fs.realpathSync(userDataDir),apps=path.join(profile,"android","apps"),root=path.resolve(record.preparedRoot);
  const directory=path.dirname(root),relative=path.relative(apps,root).split(path.sep);
  if(relative.length!==3||relative[1]!=="prepared"||!generationKey(relative[2])||fs.realpathSync(root)!==root)
    throw Error("Android package source is outside its prepared installation.");
  return locked(directory,()=>{
    const catalog=require("./service-packages").read(profile);
    if(catalog.identities[record.packageName]!==record.uid)throw Error("Android package source differs from its installed identity.");
    const file=path.join(root,"prepared.json"),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024**2)throw Error("Android package source metadata is invalid.");
    const receipt=JSON.parse(fs.readFileSync(file,"utf8"));
    if(![1,2].includes(receipt.schemaVersion)||receipt.key!==generationKey(path.basename(root))||
      !/^[a-f0-9]{64}$/.test(receipt.apkSha256||"")||receipt.metadata?.packageName!==record.packageName||
      record.apkSha256&&receipt.apkSha256!==record.apkSha256)
      throw Error("Android package source differs from its prepared identity.");
    return retainLocked(root);
  });
}

async function finishLocked(result, retain, {signal} = {}) {
  if (result.sharedInputsVersion !== 1 && !inUse(result.root)) {
    await require("./prepared-sharing").shareInputs(path.dirname(result.root), result.root, result,
      {hashFile: require("./prepare").fileHash, signal});
    const file = path.join(result.root, "prepared.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    Writable.atomicWrite(file, JSON.stringify({...receipt, sharedInputsVersion: 1}), {root: result.root});
    result.sharedInputsVersion = 1;
  }
  await pruneLocked(path.dirname(result.root), result.root);
  if (retain) handoffs.set(result, retainLocked(result.root));
  return result;
}

function inUse(root) {
  let retained = false;
  for (const file of fs.readdirSync(root)) {
    const match = /^\.use-([1-9]\d*)-[a-f0-9]{24}$/.exec(file);
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); retained = true; }
    catch (error) { if (error.code === "ESRCH") leaseChange(root, () => fs.rmSync(path.join(root, file), { force: true })); else retained = true; }
  }
  return retained;
}

/** Called under the package preparation lock. ART reads assets from its APKs;
 * older extracted copies can retire after every reader releases the generation.
 * Commit the reduced receipt first so interruption never invalidates its APKs. */
async function retireExtractedAssets(root, receipt, signal) {
  if (receipt.execution !== "art" || inUse(root)) return receipt;
  signal?.throwIfAborted();
  const assets = path.join(root, "input", "assets");
  Writable.assertOwnDirectory(root, assets);
  if (receipt.assetStorage === "apk" && !fs.readdirSync(assets).length) return receipt;
  const updated = { ...receipt, assetStorage: "apk", files: receipt.files.filter(file => !file.name.startsWith("assets/")) };
  Writable.atomicWrite(path.join(root, "prepared.json"), JSON.stringify(updated), { root });
  await fs.promises.rm(assets, { recursive: true, force: true });
  Writable.assertOwnDirectory(root, assets);
  return updated;
}

function installedSource(directory) {
  const id = path.basename(path.dirname(directory));
  try {
    const Catalog = require("./service-packages"), userData = path.resolve(directory, "../../../..");
    const record = Catalog.read(userData).packages.find(item => Catalog.storageId(item) === id);
    return record ? path.join(directory, record.preparedGeneration || record.preparedKey) : null;
  } catch { return false; } // An unreadable catalog cannot authorize source eviction.
}

async function pruneLocked(directory, current) {
  const selected = installedSource(directory);
  if (selected === false) return;
  const candidates = [];
  for (const root of generationPaths(directory)) {
    try {
      const file = path.join(root, "prepared.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024 ** 2) continue;
      const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
      if (![1, 2].includes(receipt.schemaVersion) || receipt.key !== generationKey(path.basename(root)) ||
          !/^[a-f0-9]{64}$/.test(receipt.apkSha256 || "") || !Array.isArray(receipt.files)) continue;
      candidates.push(root);
    } catch { /* Unrecognized paths are not owned conversion caches. */ }
  }
  const keep = new Set([current, selected]);
  for (const root of candidates) if (!keep.has(root) && !inUse(root)) await fs.promises.rm(root, { recursive: true, force: true });
}

const prunePrepared = (directory, current) => locked(directory, () => pruneLocked(directory, current));
/** Explicit cache maintenance also checks existing readers outside the lease
 * protocol. Ordinary preparation shares only its unleased destination. */
async function consolidatePrepared(directory, {canRewrite, signal} = {}) {
  if (typeof canRewrite !== "function") throw new TypeError("Cache consolidation requires reader inspection");
  return locked(directory, async () => {
    const result = {linkedFiles: 0, sharedBytes: 0, skipped: []};
    for (const root of generationPaths(directory)) {
      signal?.throwIfAborted();
      if (inUse(root) || !await canRewrite(root)) { result.skipped.push(root); continue; }
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(path.join(root, "prepared.json"), "utf8")); }
      catch { continue; }
      if (![1, 2].includes(receipt?.schemaVersion) || receipt.key !== generationKey(path.basename(root)) ||
          !/^[a-f0-9]{64}$/.test(receipt.apkSha256 || "") || !Array.isArray(receipt.files)) continue;
      const shared = await require("./prepared-sharing").shareInputs(directory, root, receipt,
        {hashFile: require("./prepare").fileHash, signal});
      if (receipt.sharedInputsVersion !== 1)
        Writable.atomicWrite(path.join(root, "prepared.json"), JSON.stringify({...receipt, sharedInputsVersion: 1}), {root});
      result.linkedFiles += shared.linkedFiles; result.sharedBytes += shared.sharedBytes;
    }
    return result;
  });
}
module.exports = { generationKey, generationPaths, locked, retainLocked, retainPrepared, retainPackageSource, finishLocked, prunePrepared, retireExtractedAssets, consolidatePrepared };

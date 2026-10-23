const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const Storage = require("./storage");
const Preparation = require("./prepare");
const Cache = require("./prepared-cache");
const { inspectApk } = require("./apk");

const hash = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
const packageIdentity = value => typeof value === "string" && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
const codeId = packageName => "service-" + hash(packageName);
const dataId = (packageName, callerId) => "service-data-" + hash(packageName + "\0" + callerId);
const storageId = record => record.scope === "application" ? record.gameId : codeId(record.packageName);
const missingSource = record => Object.assign(new Error("An installed Android APK is missing."), {
  code: "ANDROID_APK_SOURCE_MISSING", installedRecord: record
});
const notInstalled = packageName => Object.assign(new Error("The Android package is not installed."), {
  code: "ANDROID_PACKAGE_NOT_INSTALLED", packageName
});

async function withExistingSourceLock(directory, operation, onMissingRoot) {
  try { return await Cache.locked(directory, operation); }
  catch (error) {
    // The preparation lock belongs to the installed app root. If that whole
    // root disappeared, there is no source generation or lock to retain.
    // Do not reinterpret ENOENT from a source operation or another owner.
    if (error.code !== "ENOENT" || error.path !== path.join(path.dirname(directory), ".preparation.lock")) throw error;
    try { fs.lstatSync(path.dirname(directory)); }
    catch (missing) {
      if (missing.code === "ENOENT") return onMissingRoot();
      throw missing;
    }
    throw error;
  }
}
function location(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Android services require private launcher storage.");
  const root = path.join(userDataDir, "android", "services");
  Writable.assertOwnDirectory(userDataDir, root);
  return { root, file: path.join(root, "catalog.json") };
}

function read(userDataDir) {
  const { file } = location(userDataDir);
  let catalog;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("The Android service catalog is not a regular file.");
      catalog = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { schemaVersion: 1, nextUid: 10000, identities: {}, packages: [] };
  }
  if (catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.nextUid) || catalog.nextUid < 10000 ||
      !catalog.identities || typeof catalog.identities !== "object" || Array.isArray(catalog.identities) || !Array.isArray(catalog.packages))
    throw new Error("The Android service catalog is invalid.");
  const ids = new Map(), packages = new Set();
  for (const [name, uid] of Object.entries(catalog.identities)) {
    if (!packageIdentity(name) || !Number.isSafeInteger(uid) || uid < 10000 || uid >= catalog.nextUid || ids.has(uid))
      throw new Error("The Android package identity is invalid.");
    ids.set(uid,name);
  }
  for (const item of catalog.packages) {
    if (!packageIdentity(item.packageName) || packages.has(item.packageName) || !Object.hasOwn(catalog.identities, item.packageName) ||
        !/^[a-f0-9]{64}$/.test(item.preparedKey || "") ||
        item.preparedGeneration != null && Cache.generationKey(item.preparedGeneration) !== item.preparedKey ||
        !Array.isArray(item.sourceNames) || !item.sourceNames.length ||
        item.sourceNames.some(name => typeof name !== "string" || !name || name !== path.basename(name) || name === "." || name === "..") ||
        typeof item.processName !== "string" || !item.processName || /[\0\r\n]/.test(item.processName) ||
        !["caller", "application"].includes(item.scope) || item.scope === "application" && (!/^[\w-]{1,128}$/.test(item.gameId || "") ||
          typeof item.nativeDirectory !== "string" || item.nativeDirectory.includes("\0") || path.isAbsolute(item.nativeDirectory) || item.nativeDirectory.split(path.sep).some(part=>part===".."||part===".")) ||
        typeof item.enabled !== "boolean" || !Number.isSafeInteger(item.firstInstallTime) || !Number.isSafeInteger(item.lastUpdateTime))
      throw new Error("An installed Android service package is invalid.");
    packages.add(item.packageName);
  }
  return catalog;
}

function mutate(userDataDir, update) {
  const { root, file } = location(userDataDir);
  return require("./catalog-lock").withCatalogLock(path.join(root, "catalog.lock"), async () => {
    const catalog = read(userDataDir), result = await update(catalog);
    Writable.atomicWrite(file, JSON.stringify(catalog) + "\n", { root });
    return result;
  });
}

function identity(catalog, packageName) {
  if (!packageIdentity(packageName)) throw new Error("The Android package name is invalid.");
  if (!Object.hasOwn(catalog.identities, packageName)) {
    if (catalog.nextUid >= 2147483647) throw new Error("Android package identities are exhausted.");
    Object.defineProperty(catalog.identities, packageName, { value: catalog.nextUid++, enumerable: true, writable: true, configurable: true });
  }
  return catalog.identities[packageName];
}

function sourceFilesPresent(root, names) {
  for (const name of names) {
    let stat;
    try { stat = fs.lstatSync(path.join(root, name)); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("An installed Android APK is not a regular file.");
  }
  return true;
}

async function retainSource(userDataDir, packageName, signal) {
  const selected = read(userDataDir).packages.find(item => item.packageName === packageName);
  if (!selected) throw notInstalled(packageName);
  const directory = Storage.storagePaths(userDataDir, storageId(selected)).preparedRoot;
  return withExistingSourceLock(directory, async () => {
    signal?.throwIfAborted();
    let record = read(userDataDir).packages.find(item => item.packageName === packageName);
    if (!record) throw notInstalled(packageName);
    if (storageId(record) !== storageId(selected)) throw new Error("The Android package source owner changed.");
    let root = path.join(directory, record.preparedGeneration || record.preparedKey);
    if (!sourceFilesPresent(root, record.sourceNames)) {
      // Earlier catalogs recorded a logical key instead of the immutable COW
      // generation. Recover only verified copies of the exact installed APK.
      let found = false;
      let generations;
      try { generations = Cache.generationPaths(directory); }
      catch (error) { if (error.code !== "ENOENT") throw error; generations = []; }
      for (const candidate of generations) {
        const receipt = await Preparation.existingCache(candidate, Cache.generationKey(path.basename(candidate)), signal);
        if (!receipt || receipt.apkSha256 !== record.apkSha256 || receipt.metadata.packageName !== packageName) continue;
        root = candidate;
        const sourceNames = (receipt.sources || [{ name: receipt.sourceName || "source.apk" }]).map(item => item.name);
        record = await mutate(userDataDir, catalog => {
          const current = catalog.packages.find(item => item.packageName === packageName);
          if (!current || current.apkSha256 !== receipt.apkSha256) throw Error("The Android service package changed during preparation.");
          Object.assign(current, { preparedKey: receipt.key, preparedGeneration: path.basename(root), sourceNames });
          return { ...current };
        });
        found = true; break;
      }
      if (!found) {
        throw missingSource(record);
      }
    }
    return { record, root, sources: record.sourceNames.map(name => path.join(root, name)), release: Cache.retainLocked(root) };
  }, () => { throw missingSource(selected); });
}

// Discovery may omit an unavailable installation, but never removes its UID,
// private data or another source generation published by a concurrent owner.
async function retainDiscoveredSource(userDataDir, item, signal, required = false) {
  try { return await retainSource(userDataDir, item.packageName, signal); }
  catch (error) {
    if (required) throw error;
    if (error.code === "ANDROID_PACKAGE_NOT_INSTALLED" && error.packageName === item.packageName &&
        !read(userDataDir).packages.some(record => record.packageName === item.packageName)) return null;
    if (error.code !== "ANDROID_APK_SOURCE_MISSING" || error.installedRecord?.packageName !== item.packageName) throw error;
    const missing = error.installedRecord, directory = Storage.storagePaths(userDataDir, storageId(missing)).preparedRoot;
    const retire = () => mutate(userDataDir, catalog => {
      signal?.throwIfAborted();
      const current = catalog.packages.find(record => record.packageName === missing.packageName);
      if (!current) return true;
      if (JSON.stringify(current) !== JSON.stringify(missing)) return false;
      const root = path.join(directory, current.preparedGeneration || current.preparedKey);
      if (sourceFilesPresent(root, current.sourceNames)) return false;
      catalog.packages = catalog.packages.filter(record => record !== current); return true;
    });
    // Preserve preparation→catalog lock order. A missing whole app root has
    // no source lease and must not be recreated merely to retire metadata.
    if (await withExistingSourceLock(directory, retire, retire)) return null;
    return retainSource(userDataDir, item.packageName, signal);
  }
}

function savePrepared(userDataDir, prepared, processName, enabled = true, applicationId = null) {
  const packageName = prepared.metadata.packageName;
  const current = read(userDataDir), stored = current.packages.find(item => item.packageName === packageName);
  const selectedProcess = processName || prepared.metadata.applicationProcessName || packageName;
  const preparedGeneration = path.basename(prepared.root);
  const processes = [...new Set([selectedProcess,...(prepared.metadata.applicationProcesses||[])])];
  const scope=applicationId ? "application" : "caller";
  const sourceNames = (prepared.sourceApks || [prepared.sourceApk]).map(file => path.basename(file));
  if (applicationId && stored?.scope === "caller") return { ...stored, uid: current.identities[packageName] };
  if (stored && stored.scope === scope && stored.gameId === (applicationId || undefined) && stored.preparedKey === prepared.key && (stored.preparedGeneration || stored.preparedKey) === preparedGeneration && stored.processName === selectedProcess && JSON.stringify(stored.processes)===JSON.stringify(processes) && stored.enabled === enabled &&
      stored.apkSha256 === prepared.apkSha256 && stored.versionName === (prepared.metadata.versionName || "") &&
      stored.versionCode === (prepared.metadata.versionCode || 0) && JSON.stringify(stored.sourceNames) === JSON.stringify(sourceNames))
    return { ...stored, uid: current.identities[packageName] };
  return mutate(userDataDir, catalog => {
    const uid = identity(catalog, packageName), previous = catalog.packages.find(item => item.packageName === packageName);
    if(applicationId&&previous?.scope==="caller")return {...previous,uid};
    const now = Date.now(), record = { packageName, preparedKey: prepared.key, preparedGeneration,
      sourceNames, processName: selectedProcess, processes,
      enabled, scope, ...(applicationId ? {gameId:applicationId,nativeDirectory:path.relative(prepared.root,prepared.nativeRoot)} : {}), firstInstallTime: previous?.firstInstallTime || now,
      lastUpdateTime: previous?.apkSha256 === prepared.apkSha256 ? previous.lastUpdateTime : now,
      apkSha256: prepared.apkSha256, versionName: prepared.metadata.versionName || "", versionCode: prepared.metadata.versionCode || 0 };
    catalog.packages = [...catalog.packages.filter(item => item.packageName !== packageName), record];
    return { ...record, uid };
  });
}

/** Explicit installation of a selected APK. No acquisition or account sign-in. */
async function installServicePackage(apk, context, payload, java, dependencies = {}) {
  const metadata = (dependencies.inspect || inspectApk)(apk, { requireLauncher: false });
  if (!packageIdentity(metadata.packageName)) throw new Error("The service APK has no valid package identity.");
  const entry = { gameId: codeId(metadata.packageName), gamePath: apk, name: metadata.label || metadata.packageName };
  const prepared = await (dependencies.prepare || Preparation.prepareApk)(entry, { userDataDir: context.userDataDir,
    payload, java, signal: context.signal, onToolProcessSpawn: context.onToolProcessSpawn, requireLauncher: false, retain: true });
  const release = await (dependencies.retain || Preparation.retainPrepared)(prepared);
  try {
  if (prepared.metadata.packageName !== metadata.packageName) throw new Error("The service APK changed during installation.");
  const processName = dependencies.processName;
  if (processName != null && (typeof processName !== "string" || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?::[\w.$]+)?$/.test(processName)))
    throw new Error("The Android service process name is invalid.");
  return await savePrepared(context.userDataDir, prepared, processName);
  } finally { await release(); }
}

function setEnabled(userDataDir, packageName, enabled) {
  return mutate(userDataDir, catalog => {
    const item = catalog.packages.find(record => record.packageName === packageName);
    if (!item) throw new Error("The Android service package is not installed.");
    item.enabled = Boolean(enabled);
  });
}

function declaredProcesses(record, prepared, storage, all) {
  const processes = new Set([prepared.metadata.applicationProcessName || record.packageName, record.processName]);
  if (all) for (const name of prepared.metadata.applicationProcesses || []) processes.add(name);
  return [...processes].filter(Boolean).map(processName => {
    const processRoot = path.join(storage.root, "processes", hash(processName));
    return { record: { ...record, processName },
      storage: { ...storage, launchFile: path.join(processRoot, "launch.json"), logFile: path.join(processRoot, "runtime.log") },
      prepared: { ...prepared, filesRoot: storage.filesRoot, cacheRoot: storage.cacheRoot } };
  });
}

async function prepareInstalled(entry, game, context, payload, java, dependencies = {}) {
  if (payload.profile?.servicePackagesVersion !== 1) return null;
  const known = read(context.userDataDir).identities[game.metadata.packageName];
  const uid = dependencies.uid ?? known ?? await mutate(context.userDataDir, catalog => identity(catalog, game.metadata.packageName));
  if (payload.profile?.frameworkServicesVersion === 1 && uid >= 10000)
    await savePrepared(context.userDataDir, game, null, true, entry.gameId);
  const Google = require("./google-accounts"), google = Google.selections(entry);
  const installed = read(context.userDataDir).packages.filter(item => item.scope === "caller" && item.enabled && item.packageName !== game.metadata.packageName &&
    (!Google.isGooglePackage(item.packageName) || google.enabled));
  const services = [], releases = [], unavailablePackages = [];
  try {
    if (payload.profile?.processAuthorityVersion === 1)
      services.push(...declaredProcesses({ packageName: game.metadata.packageName, uid }, game,
        Storage.storagePaths(context.userDataDir, entry.gameId), true));
    const preparePackage = async item => {
      context.signal?.throwIfAborted();
      const source = await retainDiscoveredSource(context.userDataDir, item, context.signal,
        google.enabled && Google.isGooglePackage(item.packageName));
      if (!source) {
        unavailablePackages.push(item.packageName);
        context.logger?.warn?.("[android] Installed APK is unavailable: " + item.packageName);
        return [];
      }
      try {
      const serviceEntry = { gameId: codeId(item.packageName), gamePath: source.sources.length === 1 ? source.sources[0] : source.root, name: item.packageName,
        ...(source.sources.length > 1 ? { moduleData: { packageSet: true } } : {}) };
      const prepared = await (dependencies.prepare || Preparation.prepareApk)(serviceEntry, { userDataDir: context.userDataDir,
        payload, java, signal: context.signal, onToolProcessSpawn: context.onToolProcessSpawn, requireLauncher: false, retain: true });
      releases.push(await (dependencies.retain || Preparation.retainPrepared)(prepared));
      if (prepared.metadata.packageName !== item.packageName) throw new Error("The installed Android service identity changed.");
      const record = await savePrepared(context.userDataDir, prepared, item.processName, item.enabled);
      const storage = await (dependencies.storage || Storage.prepareStorage)({ gameId: dataId(item.packageName, entry.gameId) }, context.userDataDir,
        { signal: context.signal, payloadRoot: payload.root });
      // Discovery is complete; the supervisor starts only demanded processes.
      return declaredProcesses(record, prepared, storage, payload.profile?.providerConnectionsVersion === 1);
      } finally { await source.release(); }
    };
    // Packages have independent preparation owners. Overlap their reads and
    // tools without starting an unbounded set of cold converter processes.
    // Finish every started owner before releasing generations on failure.
    const discovered = new Array(installed.length);
    let next = 0, failed = false, failure;
    const prepareNext = async () => {
      while (!failed && next < installed.length) {
        const index = next++;
        try { discovered[index] = await preparePackage(installed[index]); }
        catch (error) { if (!failed) { failed = true; failure = error; } }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, installed.length) }, prepareNext));
    if (failed) throw failure;
    for (const processes of discovered) services.push(...processes);
    let released = false;
    return { uid, services, google, unavailablePackages, release: async () => {
      if (released) return; released = true;
      await Promise.all(releases.map(release => release()));
    } };
  } catch (error) { await Promise.allSettled(releases.map(release => release())); throw error; }
}

/** Bootstrap metadata uses the same canonical APK generations and leases as
 * launches. No game is started, converted or granted another game's data. */
async function retainApplications(userDataDir, signal) {
  const packages=[],releases=[],unavailablePackages=[];
  try {
    for(const item of read(userDataDir).packages.filter(item=>item.scope === "application" && item.enabled)){
      signal?.throwIfAborted();
      const source=await retainDiscoveredSource(userDataDir,item,signal);
      if(!source){unavailablePackages.push(item.packageName);continue;}
      releases.push(source.release);
      const record=source.record,storage=Storage.storagePaths(userDataDir,record.gameId);
      packages.push({packageName:record.packageName,sourceApks:source.sources,nativeRoot:path.join(source.root,record.nativeDirectory),
        dataRoot:storage.dataRoot,uid:read(userDataDir).identities[record.packageName],firstInstallTime:record.firstInstallTime,lastUpdateTime:record.lastUpdateTime});
    }
    return {packages,unavailablePackages,release:()=>Promise.all(releases.map(release=>release()))};
  } catch(error){await Promise.allSettled(releases.map(release=>release()));throw error;}
}

async function removeApplication(userDataDir, gameId, {retire} = {}) {
  const packages=read(userDataDir).packages.filter(item=>item.scope==="application"&&item.gameId===gameId).map(item=>item.packageName);
  if(packages.length&&retire)await retire(packages);
  await mutate(userDataDir,catalog=>{
    catalog.packages=catalog.packages.filter(item=>item.scope!=="application"||item.gameId!==gameId);
  });
}
module.exports = { read, installServicePackage, setEnabled, prepareInstalled, retainSource, retainApplications, removeApplication, storageId, codeId, dataId };

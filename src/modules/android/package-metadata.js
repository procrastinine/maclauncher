const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const Package = require("./package-set");
const Reader = require("./tools/apk-metadata");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const { readJsonObject, writeJsonAtomic } = require("../../core/json-files");
const pending = new Map();
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Resource-reader orchestration changes must invalidate cached fallback facts,
// independently of the selected runtime's package-resource protocol version.
const implementationIdentity = crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");
function applyActivityWindow(config, metadata) {
  const landscape = metadata.activityWindows?.[config.activityClass]?.landscape;
  if (typeof landscape !== "boolean" || !Number.isSafeInteger(config.width) || !Number.isSafeInteger(config.height)) return;
  if ((landscape && config.width < config.height) || (!landscape && config.width > config.height))
    [config.width, config.height] = [config.height, config.width];
}
const locale = context => context.locale || context.app?.getLocale?.() || Intl.DateTimeFormat().resolvedOptions().locale;
function statIdentity(file) {
  const real = fs.realpathSync(file), stat = fs.statSync(real);
  return [real, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
}
function sourceIdentity(entry) {
  const input = entry.gamePath, stat = fs.statSync(input);
  if (!stat.isDirectory() && Package.ARCHIVES.test(input)) return [statIdentity(input)];
  const directory = stat.isDirectory() ? input : path.dirname(input);
  return [statIdentity(input), ...fs.readdirSync(directory).filter(name => /\.apk$/i.test(name)).sort().map(name => statIdentity(path.join(directory, name)))];
}
function metadataCacheKey(entry, context) {
  let reader;
  try { reader = Reader.identity(); } catch {}
  return { source: sourceIdentity(entry), locale: locale(context), reader, implementation: implementationIdentity };
}
function preparedSourceIdentity(prepared) {
  const sources = prepared.sources || [{ name: prepared.sourceName || path.basename(prepared.sourceApk), sha256: prepared.apkSha256 }];
  return sources.every(source => typeof source.sha256 === "string") ? sources.map(({ name, sha256 }) => [name, sha256]) : null;
}
function mergeEntry(existing, incoming) {
  if (!existing?.name) return incoming;
  const automatic = [existing.moduleData?.resolvedLabel, existing.moduleData?.detectedName,
    existing.moduleData?.packageName, ...[existing.gamePath, existing.importPath].filter(Boolean).flatMap(file => [path.basename(file), path.basename(file, path.extname(file))])].filter(Boolean);
  return automatic.includes(existing.name) ? incoming : { ...incoming, name: existing.name };
}
function waitForResult(record, signal) {
  signal?.throwIfAborted(); record.waiters++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (callback, value) => { if (finished) return; finished = true; record.waiters--; signal?.removeEventListener("abort", abort); callback(value); };
    const abort = () => { settle(reject, signal.reason); if (!record.waiters && !record.complete) record.onUnused(); };
    signal?.addEventListener("abort", abort, { once: true });
    record.promise.then(value => settle(resolve, value), error => settle(reject, error));
    if (signal?.aborted) abort();
  });
}

async function read(entry, context) {
  context.signal?.throwIfAborted();
  const input = context.metadataSourceIdentity || sourceIdentity(entry), languageTag = locale(context);
  const inputIdentity = hash([input, languageTag]);
  const directory = GameData.resolveGameIconsDir(context.userDataDir, entry.gameId);
  const recordFile = path.join(directory, "android.json"), iconPath = path.join(directory, "android.png");
  const cached = readJsonObject(recordFile), cachedIconPresent = !cached?.icon || fs.existsSync(iconPath);
  const cachedResult = () => ({ ...cached, iconPath: cached.icon ? iconPath : null });
  const offlineResult = () => cached?.inputIdentity === inputIdentity && cachedIconPresent ? cachedResult() : null;
  let readerIdentity;
  try { readerIdentity = Reader.identity(); }
  catch (error) { const known = offlineResult(); if (known) return known; throw error; }
  const identity = hash([input, languageTag, 1, readerIdentity]);
  if (cached?.identity === identity && cachedIconPresent) return cachedResult();
  const key = recordFile + ":" + identity;
  if (pending.has(key)) return waitForResult(pending.get(key), context.signal);
  const controller = new AbortController();
  const record = { promise: null, waiters: 0, complete: false, onUnused() {
    if (pending.get(key) === record) pending.delete(key);
    controller.abort(new DOMException("APK metadata read cancelled.", "AbortError"));
  } };
  const operation = (async () => {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "maclauncher-android-metadata-"));
    try {
      await fs.promises.chmod(temporary, 0o700);
      let sources = context.sourceApks;
      if (!sources) {
        if (Package.ARCHIVES.test(entry.gamePath)) {
          const inputs = path.join(temporary, "inputs"); await fs.promises.mkdir(inputs, { mode: 0o700 });
          sources = (await Package.unpack(entry.gamePath, inputs, controller.signal)).map(item => item.file);
        } else sources = Package.directFiles(entry.gamePath);
      }
      // Resource inspection retains every split, independent of the runtime's
      // native ABI. Manifest identities also establish base/dependency order.
      sources = Package.inspectFiles(sources, { inspection: true, requireLauncher: false }).selected.map(item => item.file);
      const output = path.join(temporary, "output"); await fs.promises.mkdir(output, { mode: 0o700 });
      const result = await Reader.inspect({ sourceApks: sources, locale: languageTag, outputDirectory: output,
        context: { ...context, signal: controller.signal } });
      if (!record.waiters) return null;
      if (!context.metadataSourceIdentity && hash(sourceIdentity(entry)) !== hash(input))
        throw new Error("The Android package changed while reading its metadata.");
      Writable.assertOwnDirectory(context.userDataDir, directory);
      // A reader update must not discard proven resources for unchanged inputs.
      const known = offlineResult();
      const icon = Boolean(result.iconFile || known?.icon);
      if (result.iconFile) Writable.atomicWrite(iconPath, await fs.promises.readFile(result.iconFile), { root: directory });
      else if (!icon) await fs.promises.rm(iconPath, { force: true });
      const label = result.label === result.packageName && known?.packageName === result.packageName ? known.label : result.label;
      const stored = { identity, inputIdentity, label, packageName: result.packageName,
        activityWindows: result.activityWindows, icon };
      writeJsonAtomic(recordFile, stored);
      return { ...stored, iconPath: stored.icon ? iconPath : null };
    } catch (error) {
      controller.signal.throwIfAborted();
      const known = offlineResult(); if (known) return known;
      throw error;
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  })();
  // Coalesced callers own their cancellation separately. Temporary package
  // files stay retained until the native reader has actually closed.
  record.promise = operation.finally(() => { record.complete = true; if (pending.get(key) === record) pending.delete(key); });
  pending.set(key, record);
  return waitForResult(record, context.signal);
}
async function resolveGameMetadata(entry, context) {
  const metadata = await read(entry, context); if (!metadata) return null;
  return { name: metadata.label || entry.name, moduleData: { ...entry.moduleData, resolvedLabel: metadata.label } };
}
async function resolveGameIcon(entry, context) { return (await read(entry, context))?.iconPath || null; }
async function applyLaunchIdentity(config, entry, prepared, payload, java, context) {
  try {
    // Preparation verified the complete installed package set. Resource labels,
    // icons and activity policy follow those bytes, independent of original
    // input moves or a new conversion/native runtime generation.
    const identity = await read(entry, { ...context, sourceApks: prepared.sourceApks || [prepared.sourceApk],
      metadataSourceIdentity: context.metadataSourceIdentity || preparedSourceIdentity(prepared) });
    if (!identity) return;
    applyActivityWindow(config, identity);
    config.title = mergeEntry(entry, { ...entry, name: identity.label || config.title }).name;
    if (identity.iconPath) {
      config.iconFile = path.join(prepared.cacheRoot, "application-icon.png");
      const dockIcon = await require("../shared/dock-icon").prepare(identity.iconPath, prepared.cacheRoot, { signal: context.signal });
      Writable.atomicWrite(config.iconFile, await fs.promises.readFile(dockIcon), { root: prepared.cacheRoot });
    }
  } catch (error) { context.signal?.throwIfAborted(); context.logger?.debug?.("[android] Application identity: " + error.message); }
}
function dockArguments(config) { return ["-Xdock:name=" + config.title, ...(config.iconFile ? ["-Xdock:icon=" + config.iconFile] : [])]; }
module.exports = { read, metadataCacheKey, mergeEntry, resolveGameMetadata, resolveGameIcon, sourceIdentity, preparedSourceIdentity, applyActivityWindow, applyLaunchIdentity, dockArguments };

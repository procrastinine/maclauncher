const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Live = require("./live-controls"), Chain = require("./effect-chain"), Packs = require("./shader-packs"), Writable = require("../writable-input");
const Filters = require("./filter-library");
const Managed = require("./managed-shaders");
const Providers = require("./shader-providers");

// Publish an immutable, self-contained effect only after preprocessing and
// validation succeed. Running games retain the previous revision on failure.
async function prepare(entry, { root, userDataDir, features, graphicsHost, graphicsArchitecture, execute, signal, useRuntime, isCurrent, publication, force = false, directory: ownedDirectory, settings: launcherSettings }) {
  const directory = ownedDirectory || path.dirname(Live.file(entry, userDataDir)), effects = path.join(directory, "live-effects");
  if (!entry.reshade?.enabled) return effects;
  Writable.assertOwnDirectory(userDataDir, effects);
  const record = path.join(directory, "live-selection.json"), key = Live.effectKey(entry.reshade, userDataDir);
  publication?.observe(record, {root: userDataDir});
  if (isCurrent) publication?.guard(isCurrent);
  const publishSelection = value => {
    if (isCurrent && isCurrent() !== true) throw Object.assign(new Error("Graphics settings will apply on the next launch."), {code: "GRAPHICS_LIVE_STALE"});
    if (publication) publication.write(record, JSON.stringify(value), {root: userDataDir});
    else Writable.atomicWrite(record, JSON.stringify(value), {root: userDataDir});
  };
  let previous;try { previous = JSON.parse(publication ? publication.read(record, "utf8") : await fs.promises.readFile(record, "utf8")); } catch {}
  let customIdentity = null;
  if (entry.reshade.preset === "custom" && entry.reshade.effectPath) {
    try {
      const stat = await fs.promises.stat(entry.reshade.effectPath, {bigint: true});
      customIdentity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    } catch { customIdentity = "missing"; }
  }
  const managed = Managed.isId(entry.reshade.preset) ? Managed.resolveEffect(userDataDir, entry.reshade.preset, features, graphicsHost,
    {graphicsArchitecture, settings: launcherSettings}) : null;
  if (managed?.runtimeIdentity) await useRuntime?.(managed.runtimeIdentity);
  const compilerIdentity = JSON.stringify([root, graphicsArchitecture || null, customIdentity,
    ...(managed ? [managed.runtimeIdentity.version] : [])]);
  if (!force && previous?.compilerIdentity === compilerIdentity && previous?.key === key && /^[a-f0-9]{64}$/.test(previous.revision || "") &&
      ["effect.prepared.fx", "effect.slangp", "effect.hook"].some(file => fs.existsSync(path.join(effects, previous.revision, file)))) {
    const reason = Providers.availability(previous.format, { features, graphicsArchitecture });
    if (reason) throw new Error(reason);
    return effects;
  }
  const settings = entry.reshade, combined = settings.preset === "chain";
  const pack = managed || (Packs.lookup(settings.preset) ? Packs.resolveEffect(userDataDir, settings.preset, features, graphicsHost, { graphicsArchitecture })
    : Filters.isFilterId(settings.preset) ? Filters.resolve(userDataDir, settings.preset) : null);
  const revision = crypto.randomBytes(32).toString("hex"), temporary = await fs.promises.mkdtemp(path.join(directory, "live-compile-"));
  try {
    const effect = combined ? path.join(temporary, "combined.fx") : pack?.file || (settings.preset === "custom" ? settings.effectPath : path.join(root, "effects", settings.preset + ".fx"));
    if (combined) await fs.promises.writeFile(effect, Chain.source(settings.effects));
    if (!effect || !fs.statSync(effect, { throwIfNoEntry: false })?.isFile()) throw new Error("Choose an included shader or an existing .fx file.");
    const provider = Providers.packaged(effect);
    if (provider) {
      Providers.requireAvailable(provider, { features, graphicsArchitecture });
      const prepared = await provider.prepare(effect, { root, userDataDir, execute, signal });
      const bundle = path.join(temporary, "bundle");await fs.promises.mkdir(bundle);
      for (const name of [...prepared.files.map(row => row.path), "metadata.json"]) {
        const target = path.join(bundle, name);await fs.promises.mkdir(path.dirname(target), { recursive: true });
        try { await fs.promises.link(path.join(prepared.directory, name), target); }
        catch (error) { if (error.code !== "EXDEV") throw error;await fs.promises.copyFile(path.join(prepared.directory, name), target, fs.constants.COPYFILE_FICLONE); }
      }
      await fs.promises.rename(bundle, path.join(effects, revision));
      publishSelection({key, revision, compilerIdentity, format: provider.format});
      return effects;
    }
    const env = { ...process.env };for (const name of Object.keys(env)) if (name.startsWith("DYLD_") || name.startsWith("RESHADE_")) delete env[name];
    env.RESHADE_INCLUDE_PATH = [path.join(root, "include"), path.join(root, "effects"), ...(pack?.includePaths || []), path.dirname(effect)].join(path.delimiter);
    const bundle = path.join(temporary, "bundle");await fs.promises.mkdir(bundle);
    await execute(path.join(root, "fx-compile"), ["--prepare", effect, path.join(bundle, "effect.prepared.fx")], { env, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    await execute(path.join(root, "fx-compile"), [path.join(bundle, "effect.prepared.fx"), temporary],
      { env: {...env, RESHADE_EFFECT_PLAN_ROOT: bundle}, signal, timeout: 30000, maxBuffer: 1024 * 1024 });
    const requirements = require("./requirements").read(temporary, combined ? Chain.TECHNIQUE : undefined);
    if (requirements) await fs.promises.writeFile(path.join(bundle, "requirements.json"), JSON.stringify(requirements), { mode: 0o600 });
    const textures = JSON.parse(await fs.promises.readFile(path.join(temporary, "textures.json"), "utf8"));
    if (!Array.isArray(textures) || textures.length > 128) throw new Error("Too many shader image textures.");
    const roots = [path.dirname(effect), ...(pack?.texturePaths || []), path.join(path.dirname(effect), "Textures"), path.join(path.dirname(effect), "../Textures")]
      .flatMap(p => { try { return [fs.realpathSync(p)]; } catch { return []; } });
    let size = 0;const mapping = [];
    for (const [i, name] of [...new Set(textures)].entries()) {
      if (typeof name !== "string" || !name || /[\r\n\0]/.test(name)) throw new Error("Invalid shader image texture name.");
      const normalized = name.replace(/\\/g, "/");let source;
      for (const allowed of roots) { try {
        const candidate = fs.realpathSync(path.resolve(allowed, normalized));
        if (candidate.startsWith(allowed + path.sep) && fs.statSync(candidate).isFile()) { source = candidate;break; }
      } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; } }
      if (!source) throw new Error(`Shader image texture was not found: ${name}`);
      const stat = await fs.promises.stat(source);size += stat.size;
      if (stat.size > 64 * 1024 * 1024 || size > 256 * 1024 * 1024) throw new Error("Shader image textures exceed the supported size.");
      const filename = "texture-" + i;await fs.promises.copyFile(source, path.join(bundle, filename));mapping.push(normalized, filename);
    }
    await fs.promises.writeFile(path.join(bundle, "texture-sources"), mapping.join("\n") + "\n");
    await fs.promises.rename(bundle, path.join(effects, revision));
    publishSelection({key, revision, compilerIdentity, ...(requirements ? {requirements} : {})});
    return effects;
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError" || error.code === "GRAPHICS_LIVE_STALE") throw error;
    throw new Error(`The shader could not be loaded. The running effect is unchanged.\n${String(error.stderr || error.message).trim().slice(0, 1200)}`, { cause: error });
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}
module.exports = { prepare };

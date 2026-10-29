const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Plugins = require("./plugins");

function localPath(value, label, directory = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value))
    throw new Error(`${label} requires an absolute local path.`);
  let stat;
  try { stat = fs.statSync(value); } catch { throw new Error(`${label} was not found: ${value}`); }
  if (!(directory ? stat.isDirectory() : stat.isFile())) throw new Error(`${label} has the wrong file type.`);
  return value;
}
function paths(value, label) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  if (values.length > 256) throw new Error(`Too many ${label} paths.`);
  return [...new Set(values.map(value => {
    if (typeof value !== "string") throw new Error(`${label} requires local paths.`);
    return value.trim();
  }).filter(Boolean))];
}
function settings(value = {}) {
  const configDirectory = value.configDirectory ? localPath(value.configDirectory, "The mpv configuration folder", true) : null;
  const configFiles = paths(value.configFiles, "mpv configuration").map(file => localPath(file, "The mpv configuration file"));
  const scriptFiles = paths(value.scriptFiles, "mpv script").map(file => {
    localPath(file, "The mpv script", fs.existsSync(file) && fs.statSync(file).isDirectory());
    if (fs.statSync(file).isDirectory() ? !fs.statSync(path.join(file, "main.lua"), { throwIfNoEntry: false })?.isFile() && !fs.statSync(path.join(file, "main.js"), { throwIfNoEntry: false })?.isFile() : !/\.(lua|js)$/i.test(file))
      throw new Error("An mpv script must be a Lua or JavaScript file, or a folder containing main.lua or main.js.");
    return file;
  });
  const inputConfig = value.inputConfig ? localPath(value.inputConfig, "The mpv input configuration") : null;
  return { ...value, configDirectory, configFiles, scriptFiles, inputConfig };
}
function suppliedPlugin(cfg, id) {
  return cfg.scriptFiles.some(file => path.basename(file).replace(/\.(lua|js)$/i, "") === id) ||
    Boolean(cfg.configDirectory && [id, `${id}.lua`, `${id}.js`].some(name => fs.existsSync(path.join(cfg.configDirectory, "scripts", name))));
}
function required(value, userDataDir) {
  const cfg = settings(value);
  const custom = userDataDir ? Plugins.manager.listCustom(userDataDir).filter(plugin => plugin.ready && plugin.enabled !== false) : [];
  return Plugins.required(cfg).filter(pkg => !suppliedPlugin(cfg, pkg.id) && !custom.some(plugin => Plugins.provides(plugin, pkg.id)));
}
function customPlugins(cfg, userDataDir, options) {
  return Plugins.manager.listCustom(userDataDir, options).filter(plugin => plugin.enabled !== false &&
    !(cfg.uosc === false && Plugins.provides(plugin, "uosc")) && !(cfg.timelinePreviews === false && Plugins.provides(plugin, "thumbfast")));
}
function available(value, userDataDir) {
  const cfg = settings(value);
  const present = id => suppliedPlugin(cfg, id) || Boolean(userDataDir && Plugins.playbackStatus(userDataDir, id)?.ready);
  return { uosc: cfg.uosc !== false && present("uosc"), thumbfast: cfg.timelinePreviews !== false && present("thumbfast") };
}
function addDirectory(destination, source) {
  if (!source || !fs.existsSync(source)) return;
  for (const name of fs.readdirSync(source)) {
    const link = path.join(destination, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(source, name), link);
  }
}
function prepare(context, { executablePath, renderHost, thumbnailExecutablePath } = {}) {
  const cfg = settings(context.runtimeSettings);
  const usable = available(cfg, context.userDataDir);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-mpv-"));
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; fs.rmSync(directory, { recursive: true, force: true }); } };
  try {
    const installs = required(cfg, context.userDataDir).map(pkg => {
      const install = Plugins.status(context.userDataDir, pkg.id, { verification: "full" });
      return install ? { ...install, id: pkg.id } : null;
    }).filter(Boolean);
    const custom = customPlugins(cfg, context.userDataDir, { full: true });
    for (const plugin of custom) {
      if (!plugin.ready) { context.logger?.warn?.(`The ${plugin.label} plugin is unavailable for this playback.`);continue; }
      context.recordRuntimeUse?.({ managerId: Plugins.manager.id, sectionId: plugin.id, version: plugin.version, sourcePath: plugin.installDir });
      installs.push({ ...plugin, fontsDirectory: path.join(plugin.installDir, "content", "fonts"), scriptOptsDirectory: path.join(plugin.installDir, "content", "script-opts") });
    }
    // Keep all writable player state in this session. User resources remain
    // linked to their original locations, including arbitrary plugin modules.
    if (cfg.configDirectory) {
      for (const name of fs.readdirSync(cfg.configDirectory)) {
        if (!["mpv.conf", "config", "fonts", "script-opts", "watch_later"].includes(name))
          fs.symlinkSync(path.join(cfg.configDirectory, name), path.join(directory, name));
      }
    }
    const fonts = path.join(directory, "fonts"), scriptOpts = path.join(directory, "script-opts");
    fs.mkdirSync(fonts);fs.mkdirSync(scriptOpts);
    if (cfg.configDirectory) {
      addDirectory(fonts, path.join(cfg.configDirectory, "fonts"));
      addDirectory(scriptOpts, path.join(cfg.configDirectory, "script-opts"));
    }
    for (const install of installs) {
      if (install.fontsDirectory) addDirectory(fonts, install.fontsDirectory);
      if (install.scriptOptsDirectory) addDirectory(scriptOpts, install.scriptOptsDirectory);
      if (install.configFile && !fs.existsSync(path.join(scriptOpts, `${install.id}.conf`)))
        fs.symlinkSync(install.configFile, path.join(scriptOpts, `${install.id}.conf`));
    }
    const args = [`--config-dir=${directory}`, "--config=yes", "--osc=yes", `--load-scripts=${cfg.configDirectory ? "yes" : "no"}`];
    if (cfg.configDirectory) {
      const input = path.join(cfg.configDirectory, "input.conf");
      if (fs.existsSync(input)) args.push(`--input-conf=${input}`);
      const main = ["mpv.conf", "config"].map(name => path.join(cfg.configDirectory, name)).find(file => fs.existsSync(file));
      if (main) args.push(`--include=${localPath(main, "The mpv configuration file")}`);
    }
    for (const file of cfg.configFiles) args.push(`--include=${file}`);
    if (cfg.inputConfig) args.push(`--input-conf=${cfg.inputConfig}`);
    for (const install of installs) for (const script of install.scriptPaths || [install.scriptPath]) args.push(`--script=${script}`);
    for (const file of cfg.scriptFiles) args.push(`--script=${file}`);
    if (usable.uosc) args.push("--osc=no");
    if (usable.thumbfast) {
      // Each playback uses its selected managed player, including its library
      // closure. Thumbfast's worker never depends on a PATH/Homebrew install.
      const file = localPath(thumbnailExecutablePath || (!renderHost && executablePath), "The mpv thumbnail player");
      args.push(`--script-opts-append=thumbfast-mpv_path=${file}`);
    }
    return { args, directory, cleanup };
  } catch (error) { cleanup();throw error; }
}
module.exports = { settings, required, available, prepare };

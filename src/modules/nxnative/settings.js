const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Prepare = require("./prepare");
const { inside } = require("./detect");
const Writable = require("../shared/writable-input");
const { runToolCommand } = require("../shared/runtime/tool-command");

const execute = promisify(execFile);
const preferenceScript = `ObjC.import('Foundation');
function run(args) {
  var domain = args[0], changes = args[1] ? JSON.parse(args[1]) : null;
  if (changes) {
    var store = $.NSUserDefaults.alloc.initWithSuiteName($(domain));
    Object.keys(changes).forEach(function(key) {
      if (changes[key] === null) store.removeObjectForKey($(key));
      else store.setObjectForKey($(changes[key]), $(key));
    });
    store.synchronize;
  }
  var values = $.NSUserDefaults.standardUserDefaults.persistentDomainForName($(domain));
  return JSON.stringify((values ? ObjC.deepUnwrap(values) : null) || {});
}`;
async function preferences({ domain, changes, signal }) {
  const result = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", preferenceScript,
    domain, ...(changes ? [JSON.stringify(changes)] : [])], { signal, timeout: 10000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim() || "{}");
}
function readSchema(file) {
  try { return Prepare.readJson(file); } catch (error) { if (error.code === "ENOENT") return null;throw error; }
}
function schemaFor(document) {
  if (!document) return null;
  if ((document.schema ?? 1) !== 1 || !/^[0-9a-f]{16}$/i.test(document.game || "") ||
      !Array.isArray(document.settings) || document.settings.length > 128) throw new Error("Unsupported Switch game settings schema.");
  const defaults = {}, rows = new Map(), fields = [];
  for (const row of document.settings) {
    if (!row || !/^DM_[A-Z0-9_]+$/.test(row.env || "") || rows.has(row.env) ||
        typeof row.label !== "string" || row.label.length > 256 || typeof row.default !== "string") throw new Error("Invalid Switch game settings.");
    const field = { key: row.env, label: row.label, section: typeof row.section === "string" ? row.section.slice(0, 128) : undefined,
      description: typeof row.note === "string" ? row.note.slice(0, 2048) : undefined };
    if (row.kind === "choice") {
      if (!Array.isArray(row.options) || !row.options.length || row.options.length > 128 || row.options.some(option =>
        !Array.isArray(option) || option.length !== 2 || option.some(value => typeof value !== "string" || value.length > 512))) throw new Error("Invalid Switch game choices.");
      field.type = "select";field.options = row.options.map(([value, label]) => ({ value, label }));
      if (!field.options.some(option => option.value === row.default)) throw new Error("Invalid Switch game default.");
      defaults[row.env] = row.default;
    } else if (row.kind === "toggle") {
      if (typeof row.on !== "string" || typeof row.off !== "string" || row.on === row.off || ![row.on, row.off].includes(row.default)) throw new Error("Invalid Switch game toggle.");
      field.type = "boolean";defaults[row.env] = row.default === row.on;
    } else if (row.kind === "range") {
      if (![row.min, row.max, row.step, Number(row.default)].every(Number.isFinite) || row.min > row.max || row.step <= 0 || Number(row.default) < row.min || Number(row.default) > row.max) throw new Error("Invalid Switch game range.");
      field.type = "number";field.min = row.min;field.max = row.max;field.step = row.step;defaults[row.env] = Number(row.default);
    } else throw new Error("Unsupported Switch game setting kind.");
    if (row.base && Array.isArray(row.base.docked) && Array.isArray(row.base.handheld)) field.description =
      [field.description, `Base size: docked ${row.base.docked.join(" × ")}; handheld ${row.base.handheld.join(" × ")}.`].filter(Boolean).join(" ");
    rows.set(row.env, row);fields.push(field);
  }
  for (const field of fields) {
    const condition = rows.get(field.key).needs;
    if (typeof condition !== "string") continue;
    const separator = condition.indexOf("="), key = condition.slice(0, separator), value = condition.slice(separator + 1), parent = rows.get(key);
    if (separator > 0 && parent) field.visibleWhen = [{ key, equals: parent.kind === "toggle" ? value === parent.on : parent.kind === "range" ? Number(value) : value }];
  }
  return { schema: { fields, defaults }, rows, game: document.game.toLowerCase() };
}
function validValue(row, value) {
  if (typeof value !== "string") return false;
  if (row.kind === "choice") return row.options.some(option => option[0] === value);
  if (row.kind === "toggle") return value === row.on || value === row.off;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) && Number(value) >= row.min && Number(value) <= row.max;
}
function isDefault(row, value) { return row.kind === "range" ? Number(value) === Number(row.default) : value === row.default; }
function valuesFor(definition, saved) {
  const values = { ...definition.schema.defaults };
  for (const [key, row] of definition.rows) {
    const value = saved?.["launcher." + key];
    if (validValue(row, value)) values[key] = row.kind === "toggle" ? value === row.on : row.kind === "range" ? Number(value) : value;
  }
  return values;
}
function currentFile(entry, context) {
  const root = Prepare.gameDirectory(entry, context);
  const workspace = readSchema(path.join(root, "workspace.json"));
  if (typeof workspace?.preparedRelative !== "string") return null;
  const prepared = path.resolve(root, workspace.preparedRelative);
  if (!inside(path.join(root, "prepared"), prepared)) throw new Error("Invalid Switch game settings path.");
  try { if (!inside(fs.realpathSync(path.join(root, "prepared")), fs.realpathSync(prepared))) throw new Error("Invalid Switch game settings path."); }
  catch (error) { if (error.code === "ENOENT") return null;throw error; }
  return path.join(prepared, "launcher.json");
}
async function read(entry, _payload, context, dependencies = {}) {
  const file = currentFile(entry, context), definition = schemaFor(file && readSchema(file));
  if (!definition) return { schema: { fields: [] }, values: {}, message: "Game settings appear after preparation." };
  const saved = await (dependencies.preferences || preferences)({ domain: "org.nxnative." + definition.game, signal: context.signal });
  return { schema: definition.schema, values: valuesFor(definition, saved) };
}
async function write(entry, payload, context, dependencies = {}) {
  const file = currentFile(entry, context), definition = schemaFor(file && readSchema(file));
  if (!definition) throw new Error("Switch game settings are unavailable before preparation.");
  const changes = {};
  for (const [key, row] of definition.rows) {
    const incoming = payload?.values?.[key];
    const value = row.kind === "toggle" ? incoming === true ? row.on : incoming === false ? row.off : null :
      row.kind === "range" ? typeof incoming === "number" ? String(incoming) : null : incoming;
    if (!validValue(row, value)) throw new Error("Invalid value for " + row.label + ".");
    changes["launcher." + key] = isDefault(row, value) ? null : value;
  }
  const saved = await (dependencies.preferences || preferences)({ domain: "org.nxnative." + definition.game, changes, signal: context.signal });
  return { schema: definition.schema, values: valuesFor(definition, saved) };
}
async function ensure(entry, context, launch, runtime, dependencies = {}) {
  const file = path.join(launch.prepared, "launcher.json");
  if (readSchema(file)) return schemaFor(readSchema(file));
  const source = runtime.source?.root || path.join(runtime.root, "share/nxnative"), script = path.join(source, "dm/games/settings.py");
  const profile = launch.env.NXNATIVE_PROFILE;
  if (!fs.existsSync(script) || typeof launch.env.DM_ROMFS !== "string" || !profile) return null;
  const control = path.join(path.dirname(launch.env.DM_ROMFS), "control.nacp");
  if (!fs.existsSync(control)) return null;
  const game = path.basename(path.dirname(profile));
  if (!/^[0-9a-f]{16}$/i.test(game) || ![launch.prepared, runtime.root, runtime.source?.root].filter(Boolean)
    .some(root => inside(fs.realpathSync(root), fs.realpathSync(profile)))) throw new Error("Invalid prepared Switch profile.");
  Writable.assertOwnDirectory(context.userDataDir, launch.prepared);
  const shared = await (dependencies.pythonEnvironment || Prepare.pythonEnvironment)(runtime, context), python = shared?.pythonPath || path.join(runtime.root, runtime.config.runtimeFiles.python);
  const gfx = launch.env.DM_NVN_SHMAP ? "nvn" : fs.existsSync(path.join(launch.env.DM_MSL_DIR || "", "vk")) ? "vulkan" : fs.existsSync(path.join(launch.env.DM_MSL_DIR || "", "gl")) ? "gl" : "";
  await (dependencies.runCommand || runToolCommand)(python, ["-I", "-B", script, game, launch.args[0], control, file], {
    cwd: launch.prepared, logPath: path.join(launch.prepared, "settings.log"), signal: context.signal, timeout: 30000,
    env: { ...(shared?.env || process.env), SETTINGS_PLATFORM: "mac", GFXAPI: gfx,
      DM_GAMES_DIR: path.dirname(path.dirname(profile)), DM_GAMES_FIRST: "1" }, onSpawn: context.onToolProcessSpawn });
  return schemaFor(readSchema(file));
}
async function launchEnvironment(entry, context, launch, runtime, dependencies = {}) {
  const definition = await ensure(entry, context, launch, runtime, dependencies), environment = { DM_LAUNCHER: "0" };
  if (!definition || process.env.DM_SAVED_CHOICES === "0") return environment;
  const saved = await (dependencies.preferences || preferences)({ domain: "org.nxnative." + definition.game, signal: context.signal });
  for (const [key, row] of definition.rows) {
    const value = saved?.["launcher." + key];
    if (validValue(row, value) && !isDefault(row, value)) environment[key] = process.env[key] ?? value;
  }
  return environment;
}
module.exports = { schemaFor, valuesFor, read, write, ensure, launchEnvironment };

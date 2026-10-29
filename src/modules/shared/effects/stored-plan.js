const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Plan = require("./plan"), Graphics = require("../reshade/graphics-settings");

// One reader for persisted per-game graphics. `entry.effects` is the only
// source; null is the empty plan. Legacy Simple fields are upgraded once when
// a record is loaded (upgradeLegacy) and never read afterwards.
const LIMIT = 4 * 1024 * 1024, INVALID = "GRAPHICS_STORED_PLAN_INVALID", NEWER = "GRAPHICS_STORED_PLAN_NEWER";
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Validated plans are immutable by contract. The brand lets preparation and
// persistence skip a second validation of the same object.
const validated = new WeakSet(), revisions = new WeakMap();
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(item => item === undefined ? "null" : canonical(item)).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function revision(plan) {
  if (validated.has(plan) && revisions.has(plan)) return revisions.get(plan);
  const value = crypto.createHash("sha256").update(canonical(plan)).digest("hex");
  if (validated.has(plan)) revisions.set(plan, value);
  return value;
}
const brand = plan => {validated.add(plan);return plan;};
// Plan validation covers row ownership; callers repair it first (migrateOwnership).
function accept(value) { return brand(Plan.validate(value)); }
function checked(value) { return validated.has(value) ? value : accept(value); }
// Master bypass of an already validated plan, without a second validation.
function execution(value) {
  const plan = checked(value);
  return plan.enabled === false ? {...plan, video: plan.video.map(node => ({...node, enabled: false})), renderResolution: undefined, output: undefined} : plan;
}
// Renderer edits are merged before their single validation. Reject only what
// a merge could misuse: non-plain objects, reserved keys and oversize input.
const visit = (item, depth) => {
  if (depth > 16) throw new Error("Effect settings are too deeply nested.");
  if (Array.isArray(item)) { if (item.length > 4096) throw new Error("Choose a valid ordered effects plan.");for (const row of item) visit(row, depth + 1);return; }
  if (item === null || typeof item !== "object") return;
  if (!object(item)) throw new Error("Choose a valid ordered effects plan.");
  for (const key of Object.keys(item)) { if (RESERVED.has(key)) throw new Error("Invalid effect settings.");visit(item[key], depth + 1); }
};
function shape(value) {
  if (!object(value) || !Array.isArray(value.video) || value.video.length > Plan.MAX_NODES ||
      value.video.some(row => !object(row) || typeof row.id !== "string")) throw new Error("Choose a valid ordered effects plan.");
  visit(value, 0);
  return value;
}
// The same check for one desired plan, row by row: a row a merge could misuse
// is left out and reported in `dropped`, the other rows are kept. The plan's
// own fields still reject the whole value.
function shapeRows(value) {
  if (!object(value) || !Array.isArray(value.video) || value.video.length > Plan.MAX_NODES) throw new Error("Choose a valid ordered effects plan.");
  const {video, ...fields} = value, dropped = [];
  visit(fields, 1);
  const rows = video.filter((row, index) => {
    try {
      if (!object(row) || typeof row.id !== "string") throw new Error("Effect rows need unique IDs, a supported type and an enabled state.");
      visit(row, 2);return true;
    } catch (error) {
      dropped.push({part: "row", id: object(row) && typeof row.id === "string" && !RESERVED.has(row.id) ? row.id.slice(0, 128) : `#${index + 1}`, reason: message(error)});
      return false;
    }
  });
  return {value: dropped.length ? {...fields, video: rows} : value, dropped};
}
// Schema 1 graphs (v0.4.0) migrate first; ownership then repairs helpers.
// Effects of an included collection that became a managed upstream
// collection take that collection's ID.
const ownership = () => value => renamed(require("./edit-operations.mjs").migrateOwnership(object(value) && value.schema === 1 ? Plan.migrate(value) : value));
function renamed(value) {
  if (!object(value) || !Array.isArray(value.video)) return value;
  const Packs = require("../reshade/shader-packs");
  let changed = false;
  const video = value.video.map(row => {
    const preset = object(row) && row.kind === "shader" && object(row.shader) ? Packs.renamedId(row.shader.preset) : null;
    if (!preset) return row;
    changed = true;return {...row, shader: {...row.shader, preset}};
  });
  return changed ? {...value, video} : value;
}
const message = error => String(error?.message || "The saved graphics settings are invalid.").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
// The plan readers' codes (Plan.normalize) as stored-plan codes.
const CODES = Object.freeze({[Plan.PLAN_NEWER]: NEWER, [Plan.PLAN_INVALID]: INVALID});
const NEWER_MESSAGE = "These graphics settings were saved by a newer version of MacLauncher. Clear effects to edit them in this version.";
const invalid = (code, error) => ({code, message: code === NEWER ? NEWER_MESSAGE :
  `The saved graphics settings cannot be read: ${message(error)} Clear effects to edit them.`});
// A plan that does not validate as a whole is salvaged row by row
// (Plan.salvage): an unreadable row, source request or output setting is left
// out of the effective plan and reported in `dropped`, and the stored document
// is kept until the next edit saves the salvaged plan. Only a newer schema or a
// broken envelope is unreadable. The error explains why editing is blocked
// until Clear effects; the raw value stays persisted byte-equivalent.
function inspect(value, options) {
  if (object(value) && value.schema === 1) {
    const upgraded = upgradeLegacy({effects: value}, options).effects;
    return {plan: upgraded || empty().plan, migrated: true};
  }
  if (object(value) && typeof value.schema === "number" && value.schema > 2) return {error: invalid(NEWER)};
  let owned = value;
  try {
    owned = ownership()(value);
    return {plan: accept(owned), migrated: owned !== value};
  } catch {}
  const salvaged = Plan.salvage(owned);
  if (salvaged.error) return {error: invalid(CODES[salvaged.error.code] || INVALID, salvaged.error)};
  return {plan: brand(salvaged.plan), migrated: true, dropped: salvaged.dropped};
}
// A desired plan from an editor, salvaged like a stored one and validated
// once: {plan, dropped}, or {error} when its envelope cannot be read.
function salvage(value) {
  let owned = value;
  try { owned = ownership()(value); } catch {}
  const result = Plan.salvage(owned);
  if (result.error || !result.plan) return {error: {code: CODES[result.error?.code] || INVALID, message: message(result.error)}};
  return {plan: brand(result.plan), dropped: result.dropped};
}
// Keyed by the persisted bytes: reloaded records clone their objects, but an
// unchanged record does not need another validation or digest.
const stored = new Map(), STORED_ENTRIES = 64;
function remember(text, value) {
  stored.delete(text);stored.set(text, value);
  if (stored.size > STORED_ENTRIES) stored.delete(stored.keys().next().value);
}
function readEffects(raw) {
  let text;
  try { text = JSON.stringify(raw); } catch {}
  const cached = text !== undefined && stored.get(text);
  const dropped = rows => rows?.length ? {dropped: rows.map(row => ({...row}))} : {};
  if (cached) {
    remember(text, cached);
    if (cached.error) return {source: "invalid", error: {...cached.error}, raw};
    const plan = brand(structuredClone(cached.plan));revisions.set(plan, cached.revision);
    return {source: "effects", plan, revision: cached.revision, migrated: cached.migrated, ...dropped(cached.dropped)};
  }
  const result = inspect(raw);
  if (result.error) {
    if (text !== undefined && text.length <= LIMIT) remember(text, {error: result.error});
    return {source: "invalid", error: result.error, raw};
  }
  const value = {plan: structuredClone(result.plan), revision: revision(result.plan), migrated: result.migrated, ...dropped(result.dropped)};
  if (text !== undefined && text.length <= LIMIT) remember(text, value);
  return {source: "effects", plan: result.plan, revision: value.revision, migrated: result.migrated, ...dropped(result.dropped)};
}
let none;
function empty() {
  none ||= {plan: accept({schema: 2, mode: "advanced", enabled: true, video: []})};
  none.revision ||= revision(none.plan);
  const plan = brand(structuredClone(none.plan));revisions.set(plan, none.revision);
  return {source: "effects", plan, revision: none.revision, migrated: false};
}
// A record that still holds v0.4.0 data (its one-time write failed) is
// upgraded in memory; `upgraded` is the record for the caller to persist.
function read(entry = {}, options) {
  if (!legacy(entry)) return entry.effects == null ? empty() : readEffects(entry.effects);
  const upgraded = upgradeLegacy(entry, options);
  return {...(upgraded.effects == null ? empty() : readEffects(upgraded.effects)), migrated: true, upgraded};
}
// A record keeps a valid plan as is and an invalid one byte-equivalent. Only
// a value that cannot be stored as bounded JSON becomes an explicit marker.
function serialize(value) {
  if (value == null) return null;
  let text;
  try { text = JSON.stringify(value); } catch {}
  if (typeof text !== "string" || text.length > LIMIT)
    return {error: INVALID, reason: "The saved graphics settings exceeded the 4 MiB limit or were not JSON."};
  if (validated.has(value) && !stored.has(text)) remember(text, {plan: JSON.parse(text), revision: revision(value), migrated: false});
  return JSON.parse(text);
}
// Notices for the parts of a read plan that salvage left out. Upgrade notices
// share the shape {message, rowId?}: `rowId` names a row kept off in the plan,
// and `dropped: true` marks a part that is not in the effective plan.
const OUTPUT_LABELS = Object.freeze({motionClarity: "display subframe settings", framePacing: "frame pacing settings", toneMapping: "output tone mapping",
  adaptiveQuality: "adaptive quality setting", comparison: "image comparison setting"});
function notices(result) {
  return (Array.isArray(result?.dropped) ? result.dropped : []).map(row => {
    const name = row.part === "output" ? String(row.id).replace(/^output\.?/, "") : "";
    const what = row.part === "row" ? `effect ${quoted(row.label || row.id)}` : row.part === "renderResolution" ? "source resolution" :
      row.part === "depthInput" ? "depth input setting" :
      !name ? "output settings" : OUTPUT_LABELS[name] || `output setting ${quoted(name)}`;
    return {message: `The saved ${what} is skipped. ${message({message: row.reason})}`.slice(0, 1024), dropped: true};
  });
}
// The coded Error for an unreadable read result, or for an error thrown by a
// plan reader (GRAPHICS_PLAN_NEWER/INVALID become this module's codes).
function error(result) {
  if (result instanceof Error) return CODES[result.code] ? Object.assign(new Error(result.message), {code: CODES[result.code]}) : result;
  return result?.source === "invalid" ? Object.assign(new Error(result.error.message), {code: result.error.code}) : null;
}

// One-time upgrade of v0.4.0 Simple fields. The result equals the plan the
// editor showed for them. It is total: each selection converts on its own; a
// missing file or retired method leaves its row off with a notice (or only a
// notice when no row can hold it), and nothing here throws.
const PARTS = Object.freeze({
  shader: {row: "legacy-shader", label: "shader"},
  spatialShader: {row: "legacy-spatial-shader", label: "scaling shader"},
  temporal: {row: "legacy-temporal", label: "temporal upscaling"},
  spatial: {row: "legacy-spatial", label: "spatial scaling"},
  generation: {row: "legacy-frame-generation", label: "frame generation"},
  neural: {row: "legacy-neural", label: "neural rendering"}
});
const TOTAL = "The saved graphics settings could not be converted and were cleared.";
const quoted = value => "“" + String(typeof value === "string" ? value : JSON.stringify(value) ?? value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256) + "”";
// Managed stores keep their layout below the launcher data directory. A file
// from another profile maps to this profile's copy; a neural model maps by
// version, since its package name depends on the operation.
const STORES = ["runtimes/graphics-neural-models", "runtimes/graphics-shader-library", "runtimes/lossless-models", "runtimes/reshade-shaders", "graphics"];
function readable(file) {
  try { const stat = fs.statSync(file);fs.accessSync(file, fs.constants.R_OK);return stat.isFile() || stat.isDirectory(); } catch { return false; }
}
function relocated(file, userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) return null;
  const parts = path.normalize(file).split(path.sep);
  for (const store of STORES) {
    const segments = store.split("/");
    for (let index = parts.length - segments.length - 1; index > 0; index--) {
      if (!segments.every((segment, offset) => parts[index + offset] === segment)) continue;
      const rest = parts.slice(index + segments.length), candidate = path.join(userDataDir, ...segments, ...rest);
      if (readable(candidate)) return candidate;
      if (store === "runtimes/graphics-neural-models") {
        const model = require("../reshade/neural/models").listInstalled(userDataDir).find(item => item.version === rest[0]);
        if (model) return model.modelPath;
      }
      if (store === "runtimes/reshade-shaders" && rest.length > 2) try {
        const pack = path.join(userDataDir, ...segments, rest[0]);
        for (const version of fs.readdirSync(pack).sort().reverse()) {
          const moved = path.join(pack, version, ...rest.slice(2));
          if (readable(moved)) return moved;
        }
      } catch {}
      break;
    }
  }
  return null;
}
const locate = (file, ctx) => readable(file) ? file : relocated(file, ctx.userDataDir);
// The files a representable shader selection names: a custom file (remapped
// when moved) or an imported filter. Returns the settings to keep and, when
// unusable, the reason.
function shaderFiles(settings, ctx) {
  const Filters = require("../reshade/filter-library");
  if (settings.preset === "custom" && typeof settings.effectPath === "string") {
    const found = locate(settings.effectPath, ctx);
    return found ? {settings: {...settings, effectPath: found}} :
      {settings, reason: `The saved shader file ${quoted(settings.effectPath)} is missing or unreadable. Restore it or choose another file to use this effect.`};
  }
  if (Filters.isFilterId(settings.preset)) try { Filters.resolve(ctx.userDataDir, settings.preset); }
  catch (error) { return {settings, reason: `The saved imported filter is unavailable: ${message(error)}`}; }
  return {settings};
}
// A saved shader selection: {settings} when usable, {settings, reason} when
// its row stays off, {reason} when no row can represent it.
function shaderSelection(raw, ctx) {
  const ShaderSettings = require("../reshade/shader-settings"), Packs = require("../reshade/shader-packs");
  const Filters = require("../reshade/filter-library"), Managed = require("../reshade/managed-shaders");
  const preset = raw.preset;
  if (typeof preset !== "string") return {reason: "The saved shader selection could not be read."};
  if (!(ShaderSettings.PRESETS.some(item => item.id === preset) || Filters.isFilterId(preset) || Managed.isId(preset) || Packs.normalizeId(preset)))
    return {reason: `The saved shader ${quoted(preset)} is no longer available.`};
  const settings = ShaderSettings.normalizeSettings(raw), file = raw.effectPath;
  if (settings.preset === "custom" && (typeof file !== "string" || !file))
    return {settings: {...settings, effectPath: null}, reason: "The saved custom shader has no file. Choose a shader file to use this effect."};
  if (settings.preset === "custom" && (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || !require("../reshade/shader-providers").sourceExtensions.includes(path.extname(file).toLowerCase())))
    return {settings: {...settings, effectPath: null}, reason: `The saved shader path ${quoted(file)} is not a supported absolute shader file. Choose the file again to use this effect.`};
  return shaderFiles(settings, ctx);
}
// Normalized legacy input plus the selections that stay off ({part: reason}).
function sanitize(entry, ctx, notices) {
  const ReShade = require("../reshade");
  const rawShader = object(entry.reshade) ? entry.reshade : {}, rawGraphics = object(entry.graphics) ? entry.graphics : {};
  if (entry.reshade != null && !object(entry.reshade)) notices.push({message: "The saved shader settings could not be read and were cleared."});
  if (entry.graphics != null && !object(entry.graphics)) notices.push({message: "The saved scaling and frame generation settings could not be read and were cleared."});
  const graphics = Graphics.normalizeSettings(rawGraphics), off = {};
  let reshade = ReShade.normalizeSettings(rawShader);
  if (reshade.enabled) {
    const selected = shaderSelection(rawShader, ctx);
    if (!selected.settings) {notices.push({message: selected.reason});reshade = {...reshade, enabled: false};}
    else {reshade = {...selected.settings, enabled: true};if (selected.reason) off.shader = selected.reason;}
  }
  const rawSpatialShader = rawGraphics.spatialShader;
  if (object(rawSpatialShader) && rawSpatialShader.enabled !== false) {
    const selected = shaderSelection(rawSpatialShader, ctx);
    if (!selected.settings) notices.push({message: selected.reason.replace("shader", "scaling shader")});
    else {
      Object.assign(graphics, {spatialShader: {...selected.settings, enabled: true}, spatialMethod: "off"});
      if (selected.reason) off.spatialShader = selected.reason;
    }
  }
  // Retired or unknown methods cannot form a row; their notice keeps the value.
  for (const [part, key, valid] of [["temporal", "temporalMethod", value => Graphics.TEMPORAL_METHODS.includes(value)],
    ["spatial", "spatialMethod", Graphics.spatialMethod], ["generation", "frameGeneration", value => ["off", "lsfg"].includes(value)],
    ["neural", "neuralMethod", value => ["off", "mlx-dlss"].includes(value)]]) {
    const value = rawGraphics[key];
    if (value === undefined || value === null || valid(value)) continue;
    notices.push({message: `The saved ${PARTS[part].label} method ${quoted(value)} is no longer available.`});
    graphics[key] = "off";
  }
  if (graphics.neuralMethod === "mlx-dlss" && rawGraphics.neuralModelPath != null) {
    const file = rawGraphics.neuralModelPath;
    if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) {
      graphics.neuralModelPath = null;
      off.neural = `The saved neural model path ${quoted(file)} is not an absolute file path. Choose a model to use neural rendering.`;
    } else {
      const found = locate(file, ctx);
      if (found) graphics.neuralModelPath = found;
      else off.neural = `The saved neural model ${quoted(file)} is missing or unreadable. Choose a model to use neural rendering.`;
    }
  }
  if (typeof graphics.modelVersion === "string" && graphics.modelVersion.startsWith("/")) {
    const found = locate(graphics.modelVersion, ctx), uses = [graphics.spatialMethod === "ls1" && "spatial", graphics.frameGeneration === "lsfg" && "generation"].filter(Boolean);
    if (found) graphics.modelVersion = found;
    else for (const part of uses) off[part] ||= `The saved Lossless Scaling model ${quoted(graphics.modelVersion)} is missing or unreadable. Choose installed models to use this row.`;
  }
  const methods = key => graphics[key] !== "off" ? [graphics[key]] : [];
  ctx.selectedMethods = {spatial: methods("spatialMethod"), temporal: methods("temporalMethod"), neural: methods("neuralMethod"), generation: methods("frameGeneration")};
  if (graphics.spatialMethod.startsWith("libplacebo:")) {
    const labels = ctx.capabilities.spatialMethodLabels;
    if (object(labels) && !Object.hasOwn(labels, graphics.spatialMethod))
      off.spatial = `The saved libplacebo filter ${quoted(graphics.spatialMethod.slice(11))} is no longer available. Choose another scaling method.`;
  }
  return {reshade, graphics, off};
}
const ACTIVE = {shader: input => input.reshade.enabled, spatialShader: input => input.graphics.spatialShader?.enabled === true,
  temporal: input => input.graphics.temporalMethod !== "off", spatial: input => input.graphics.spatialMethod !== "off",
  generation: input => input.graphics.frameGeneration !== "off", neural: input => input.graphics.neuralMethod !== "off"};
function only(input, parts) {
  const graphics = {...input.graphics}, keep = new Set(parts);
  if (!keep.has("spatialShader")) graphics.spatialShader = null;
  for (const [part, key] of [["temporal", "temporalMethod"], ["spatial", "spatialMethod"], ["generation", "frameGeneration"], ["neural", "neuralMethod"]])
    if (!keep.has(part)) graphics[key] = "off";
  return {...input, reshade: keep.has("shader") ? input.reshade : {...input.reshade, enabled: false}, graphics};
}
const attachment = traits => require("./providers").MODEL_OPERATIONS[traits?.modelOperation]?.kind === "attachment";
// The editor's Simple composition of v0.4.0 settings (formerly automaticPlan
// in draft mode), with the selections that produced its source request.
function compose({reshade: selected, graphics}, ctx) {
  const ReShade = require("../reshade"), Packs = require("../reshade/shader-packs"), Filters = require("../reshade/filter-library"), Managed = require("../reshade/managed-shaders");
  const spatialShader = graphics.spatialShader?.enabled === true, neural = graphics.neuralMethod === "mlx-dlss", shaderFacts = {};
  const selection = settings => { try { return ReShade.resolveShaderSelection({reshade: settings}, ctx.resolution); } catch { return null; } };
  if (selected.enabled && (Graphics.enabled(graphics) || selected.preset === "custom" || Filters.isFilterId(selected.preset) || Managed.isId(selected.preset) || Packs.lookup(selected.preset))) {
    // Unavailable selections are handled by normal per-row preparation. Their
    // absence must not prevent independent scaling or generation from working.
    const facts = selection(selected);
    shaderFacts["legacy-shader"] = {requirements: Packs.lookup(selected.preset)?.effect.requires || [], ...(facts ? {traits: facts.traits, requirements: facts.requirements} : {})};
  }
  if (spatialShader) {
    const facts = selection(graphics.spatialShader);
    shaderFacts["legacy-spatial-shader"] = facts ? {traits: facts.traits, requirements: facts.requirements} : {};
  }
  const shader = shaderFacts["legacy-shader"]?.traits;
  const resizing = selected.enabled && Boolean(shaderFacts["legacy-shader"]) && require("./contracts.mjs").shaderResizes({traits: shader});
  const modelShader = selected.enabled && attachment(shader) || attachment(shaderFacts["legacy-spatial-shader"]?.traits);
  const processing = {...graphics};
  const fit = () => ["metalfx", "bicubic", "bilinear"].find(method => ctx.capabilities.spatial && ctx.capabilities.spatialMethods?.includes(method));
  // Legacy preferences retain their explicit factor or pixel height. A new
  // image reconstruction uses a fixed processing height; decoded media keeps
  // its original pixels unless a reduction was explicitly selected.
  if (neural && processing.neuralInputHeight === null && processing.neuralInputScale === null) {
    if (ctx.nativeVideo) processing.neuralInputScale = 1;
    else processing.neuralInputHeight = Plan.DEFAULT_PROCESSING_HEIGHT;
  }
  const neuralFit = neural && processing.spatialMethod === "off" && !spatialShader;
  if (neuralFit) processing.spatialMethod = fit() || "bilinear";
  let plan = Plan.composeSimple({reshade: selected, graphics: processing}, {shaderFacts});
  if (spatialShader) {
    // A hook may have an intrinsic scale (for example fixed 2×). Final fitting
    // follows its actual output and is an equal-size no-op when already fitted.
    const method = fit();
    if (method) {
      const {spatialShader: _selection, ...settings} = processing;
      const generation = plan.video.findIndex(row => row.kind === "frame-generation");
      plan.video.splice(generation < 0 ? plan.video.length : generation, 0,
        {id: "legacy-spatial-fit", kind: "spatial", enabled: true, method,
          settings: {...settings, spatialMethod: method, spatialMultiplier: null, temporalMethod: "off", frameGeneration: "off"}});
      plan = Plan.orderSimple(plan, {shaderFacts});
    }
  }
  // A scene-only engine scale is already enlarged before its UI composite.
  // Reducing that composite again would blur it. Completed-frame neural work
  // keeps the engine's sharp original and reduces only once in the plan.
  let sources = [];
  const SourceResolution = require("../reshade/source-resolution");
  if ((neural || graphics.spatialMethod !== "off" || resizing || spatialShader) && (neural || graphics.spatialMultiplier != null)) {
    const source = ctx.sourceControl;
    if (neural && source.control !== "engine" && processing.neuralInputHeight !== null) {plan.renderResolution = {height: processing.neuralInputHeight};sources = ["neural"];}
    else if (neural && source.control !== "engine" && processing.neuralInputScale < 1 && SourceResolution.DIVISORS.includes(1 / processing.neuralInputScale)) {
      plan.renderResolution = {multiplier: 1 / processing.neuralInputScale};sources = ["neural"];
    } else if (!neural && graphics.spatialMultiplier != null) {
      plan.renderResolution = {multiplier: graphics.spatialMultiplier, ...(source.methods?.includes(graphics.spatialMethod) ? {method: graphics.spatialMethod} : {})};
      sources = [graphics.spatialMethod !== "off" && "spatial", resizing && "shader", spatialShader && "spatialShader"].filter(Boolean);
    }
  }
  for (const row of plan.video) if (row.kind === "spatial") row.settings.spatialMultiplier = null;
  plan = Plan.migrate(plan);
  if (modelShader) plan.video = plan.video.map(row => row.kind === "shader" && attachment(shaderFacts[row.id]?.traits) ? {...row, settings: {modelPath: null}} : row);
  // Rows the composition added for a selection are that selection's helpers.
  const owners = {"legacy-neural-input": {id: "legacy-neural", role: "input"}, "legacy-spatial-fit": {id: "legacy-spatial-shader", role: "fit"},
    ...(neuralFit ? {"legacy-spatial": {id: "legacy-neural", role: "fit"}} : {})};
  plan.video = plan.video.map(row => owners[row.id] && plan.video.some(owner => owner.id === owners[row.id].id) ? {...row, ownedBy: {...owners[row.id]}} : row);
  return {plan, sources};
}
// A converted plan with its unusable selections off. Helpers follow their
// owner, and a source request made only for an unusable selection is dropped.
function build(input, ctx, notices) {
  const {plan: composed, sources} = compose(input, ctx);
  let plan = ownership()(composed);
  const parts = Object.keys(input.off).filter(part => ACTIVE[part](input));
  if (parts.length) {
    const ids = new Set(parts.map(part => PARTS[part].row));
    plan = {...plan, video: plan.video.map(row => ids.has(row.id) || ids.has(row.ownedBy?.id) ? {...row, enabled: false} : row)};
    if (plan.renderResolution && sources.length && sources.every(part => parts.includes(part))) {const {renderResolution: _source, ...rest} = plan;plan = rest;}
    for (const part of parts) {
      const row = PARTS[part].row;
      notices.push({...(plan.video.some(item => item.id === row) ? {rowId: row} : {}), message: input.off[part]});
    }
  }
  return accept(plan);
}
// Lazy facts: capability and source discovery run only for selections that
// need them, once per record.
function upgradeContext(options) {
  const ReShade = require("../reshade");
  const root = () => options.root || ReShade.runtimeRoot(options.app);
  let capabilities = options.graphicsCapabilities, sourceControl;
  const context = {userDataDir: options.userDataDir, nativeVideo: options.graphicsInputs?.nativeVideo === true, selectedMethods: undefined,
    resolution: {userDataDir: options.userDataDir, get root() { return root(); }, graphicsHost: options.graphicsHost, graphicsArchitecture: options.graphicsArchitecture,
      nativeVideo: options.graphicsInputs?.nativeVideo === true, macOSVersion: options.macOSVersion, settings: options.settings},
    get capabilities() {
      if (capabilities) return capabilities;
      try { capabilities = Graphics.capabilities(root(), options.graphicsHost, {...options, selectedMethods: context.selectedMethods}) || {}; } catch { capabilities = {}; }
      return capabilities;
    },
    get sourceControl() {
      if (sourceControl) return sourceControl;
      try {
        const support = context.capabilities, source = require("../reshade/source-resolution").capabilities(options.graphicsHost, options.graphicsInputs || null,
          support.resolutionMultipliers || [], support.virtualWindow);
        sourceControl = {control: source.control, methods: source.methods};
      } catch { sourceControl = {}; }
      return sourceControl;
    }};
  return context;
}
function convert(entry, options) {
  const notices = [], ctx = upgradeContext(options), input = sanitize(entry, ctx, notices);
  const active = Object.keys(PARTS).filter(part => ACTIVE[part](input));
  let plan;
  try { const attempt = [];plan = build(input, ctx, attempt);notices.push(...attempt); }
  catch {
    // Each selection converts on its own; one that still fails is reported.
    let kept = [], attempt = [];
    plan = build(only(input, kept), ctx, attempt);
    for (const part of active) {
      const next = [...kept, part], trial = [];
      try { plan = build(only(input, next), ctx, trial);kept = next;attempt = trial; }
      catch (error) { notices.push({message: `The saved ${PARTS[part].label} setting could not be converted: ${message(error)}`}); }
    }
    notices.push(...attempt);
  }
  const blank = !plan.video.length && plan.renderResolution == null && plan.output == null;
  return {effects: blank ? null : plan, notices};
}
// A v0.4.0 Advanced graph is kept when it validates, otherwise rebuilt from
// the plan fields and rows that still do. Files its rows name are checked
// like the Simple selections.
const FIELDS = {enabled: "master switch", renderResolution: "source resolution", output: "output settings"};
function rebuildLegacy(raw, notices) {
  const owned = value => accept(ownership()(value));
  try { return owned(raw); } catch {}
  if (!object(raw) || !Array.isArray(raw.video)) {notices.push({message: TOTAL});return null;}
  let base = {schema: raw.schema === 1 ? 1 : 2, mode: "advanced"}, kept = [];
  const field = key => {
    if (raw[key] === undefined) return;
    try { owned({...base, [key]: raw[key], video: kept});base = {...base, [key]: raw[key]}; }
    catch (error) { notices.push({message: `The saved ${FIELDS[key]} could not be converted: ${message(error)}`}); }
  };
  field("enabled");
  for (const row of raw.video) {
    try { owned({...base, video: [...kept, row]});kept = [...kept, row]; }
    catch (error) { notices.push({message: `The saved effect ${quoted(object(row) ? row.id : row)} could not be converted: ${message(error)}`}); }
  }
  field("renderResolution");field("output");
  return owned({...base, video: kept});
}
function attend(plan, ctx, notices) {
  const off = new Map();
  let changed = false;
  const moved = (file, reason) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) return {file};
    const found = locate(file, ctx);
    if (found !== file) changed = true;
    return found ? {file: found} : {file, reason: reason(quoted(file))};
  };
  const video = plan.video.map(row => {
    let next = row, reason;
    if (row.kind === "shader") {
      const result = shaderFiles(row.shader, ctx);
      if (result.settings.effectPath !== row.shader.effectPath) {changed = true;next = {...next, shader: result.settings};}
      reason = result.reason;
    }
    for (const [key, applies] of [["modelPath", true], ["modelVersion", ["ls1", "lsfg"].includes(row.method)]]) {
      if (!applies || reason || typeof row.settings?.[key] !== "string" || !row.settings[key].startsWith("/")) continue;
      const result = moved(row.settings[key], file => `The saved model ${file} is missing or unreadable. Choose a model to use this row.`);
      if (result.file !== row.settings[key]) next = {...next, settings: {...next.settings, [key]: result.file}};
      reason = result.reason;
    }
    if (reason && row.enabled && row.ownedBy === undefined) off.set(row.id, reason);
    return next;
  });
  if (!off.size && !changed) return plan;
  for (const [rowId, reason] of off) notices.push({rowId, message: reason});
  return accept(ownership()({...plan, video: video.map(row => off.has(row.id) || off.has(row.ownedBy?.id) ? {...row, enabled: false} : row)}));
}
// A module adapts its own v0.4.0 Simple fields before conversion through
// `upgradeLegacyGraphics(graphics)`, for a selection that its own setting
// carried rather than a graph row. A failing adapter leaves the fields as saved.
function moduleGraphics(entry) {
  if (!object(entry.graphics)) return entry;
  try {
    const adapt = require("../../registry").getModule(entry.moduleId || entry.engine)?.upgradeLegacyGraphics;
    const graphics = typeof adapt === "function" ? adapt(entry.graphics) : entry.graphics;
    return object(graphics) && graphics !== entry.graphics ? {...entry, graphics} : entry;
  } catch { return entry; }
}
const legacy = entry => object(entry) && (Object.hasOwn(entry, "reshade") || Object.hasOwn(entry, "graphics") || object(entry.effects) && entry.effects.schema === 1);
// Returns the record unchanged when it holds nothing from v0.4.0, otherwise a
// copy without the Simple fields whose `effects` is schema 2 (or null), plus
// any `effectsNotices`. The caller persists that copy in one atomic write; a
// second call returns it unchanged.
function upgradeLegacy(entry, options = {}) {
  if (!legacy(entry)) return entry;
  const {reshade: _shader, graphics: _graphics, ...record} = entry;
  let result;
  // v0.4.0 saved only schema 1. A later graph supersedes the Simple fields
  // and is kept byte-equivalent; an invalid one blocks editing (Q1).
  if (entry.effects != null && !(object(entry.effects) && entry.effects.schema === 1)) return record;
  if (entry.effects != null) {
    const notices = [];
    try { const plan = rebuildLegacy(entry.effects, notices);result = {effects: plan && attend(plan, upgradeContext(options), notices), notices}; }
    catch { result = {effects: null, notices: [...notices, {message: TOTAL}]}; }
  } else try { result = convert(moduleGraphics(entry), options); } catch { result = {effects: null, notices: [{message: TOTAL}]}; }
  const notices = [...(Array.isArray(entry.effectsNotices) ? entry.effectsNotices : []), ...result.notices];
  return {...record, effects: result.effects, ...(notices.length ? {effectsNotices: notices} : {})};
}

module.exports = {INVALID, NEWER, LIMIT, read, serialize, revision, canonical, inspect, accept, checked, execution, shape, shapeRows, salvage, notices, error, upgradeLegacy,
  isLegacy: legacy, isValidated: value => validated.has(value)};

// Shader option values copied between rows and taken from RetroArch .slangp
// and ReShade .ini presets. Parsing and matching are browser-safe; the
// effects editor applies the matched values as ordinary parameter edits.

// RetroArch preset keys that describe passes, textures and framebuffers
// rather than parameter values.
const SLANGP_STRUCTURE = /^(?:shaders|parameters|textures|feedback_pass|shader\d+|alias\d+|scale(?:_type)?(?:_[xy])?\d+|filter_linear\d+|wrap_mode\d+|mipmap_input\d+|float_framebuffer\d+|srgb_framebuffer\d+|frame_count_mod\d+)$/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const LISTED = 8;

const baseName = file => String(file || "").split(/[\\/]/).pop();
const list = names => names.slice(0, LISTED).join(", ") + (names.length > LISTED ? ", …" : "");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
// ReShade's compiler describes a uniform as V__<name>, or V__MLStage<n>__<name>
// in combined effects; presets name the uniform as its source declares it.
const sourceName = name => name.replace(/^V__(?:MLStage\d+__)?/, "");

/** The text format of a row's options: ReShade for .fx files, RetroArch for .slangp and .slang, plain lines otherwise. */
export function shaderOptionsFormat(effectFile) {
  const extension = /\.([^.\\/]+)$/.exec(baseName(effectFile))?.[1].toLowerCase();
  return extension === "fx" ? "reshade" : extension === "slangp" || extension === "slang" ? "slangp" : "lines";
}

/**
 * Reads `name = value` lines into sections. The top level has the name "".
 * Values are one to four comma-separated numbers; RetroArch quotes them.
 * Paths, technique lists and other text values are not options.
 */
export function parseShaderOptions(text) {
  const sections = new Map([["", new Map()]]);
  // Sections or a technique list mark a ReShade preset.
  let section = "", reshade = false;
  for (const raw of String(text ?? "").replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || /^(?:#|;|\/\/)/.test(line)) continue;
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header) {
      section = header[1].trim();reshade = true;
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const entry = /^([^=\s"]+)\s*=\s*(.*)$/.exec(line);
    if (entry && /^Techniques$/i.test(entry[1])) reshade = true;
    if (!entry || section === "" && SLANGP_STRUCTURE.test(entry[1])) continue;
    const quoted = /^"([^"]*)"/.exec(entry[2]);
    const value = (quoted ? quoted[1] : entry[2].replace(/\s+(?:#|;|\/\/).*$/, "")).trim();
    const parts = value.split(",").map(part => part.trim());
    if (parts.length > 4 || !parts.every(part => NUMBER.test(part))) continue;
    const numbers = parts.map(Number);
    if (numbers.every(Number.isFinite)) sections.get(section).set(entry[1], numbers);
  }
  return {sections, reshade};
}

/**
 * The option values of one effect: the `[<effect file>]` section of a ReShade
 * preset, or else the top-level lines that older presets, RetroArch presets
 * and copied options use. A ReShade preset's top-level `Key<technique>`
 * entries are toggle shortcuts, not options.
 */
export function selectShaderOptions(parsed, effectFile) {
  const effect = baseName(effectFile).toLowerCase();
  const named = effect ? [...parsed.sections.keys()].find(name => name && baseName(name).toLowerCase() === effect) : undefined;
  if (named !== undefined && parsed.sections.get(named).size) return parsed.sections.get(named);
  const values = new Map([...parsed.sections.get("")].filter(([name]) => !(parsed.reshade && /^Key./.test(name))));
  if (values.size) return values;
  const others = [...parsed.sections].filter(([name, entries]) => name && entries.size).map(([name]) => name);
  if (others.length) throw new Error(`These options are for ${list(others)}${effect ? `, not ${baseName(effectFile)}` : ""}.`);
  throw new Error("No shader option values were found.");
}

// The value an edit control would accept: finite, clamped to the declared
// range, whole for integers, 0 or 1 for switches and a listed choice for menus.
function accepted(parameter, value) {
  if (!Number.isFinite(value)) return undefined;
  if (parameter.type === "bool") return value !== 0 ? 1 : 0;
  if (parameter.options?.length) return parameter.options.some(option => option.value === value) ? value : undefined;
  let next = parameter.type === "int" ? Math.round(value) : value;
  if (typeof parameter.min === "number" && next < parameter.min) next = parameter.min;
  if (typeof parameter.max === "number" && next > parameter.max) next = parameter.max;
  return Number.isFinite(Math.fround(next)) ? next : undefined;
}

/**
 * Matches option names to a shader's described parameters, by described or
 * source name, exactly and then ignoring case. Components the source leaves
 * out keep their current values.
 */
export function matchShaderOptions(options, parameters, current = {}) {
  const exact = new Map(), folded = new Map();
  for (const key of [parameter => parameter.name, parameter => sourceName(parameter.name)])
    for (const parameter of parameters) {
      const name = key(parameter);
      if (!exact.has(name)) exact.set(name, parameter);
      if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), parameter);
    }
  const values = {}, imported = [], missing = [], rejected = [];
  for (const [name, numbers] of options) {
    const parameter = exact.get(name) || folded.get(name.toLowerCase());
    if (!parameter) {missing.push(name);continue;}
    const base = Array.isArray(current[parameter.name]) ? current[parameter.name] : parameter.default;
    const next = parameter.default.map((fallback, index) => index < numbers.length ? accepted(parameter, numbers[index]) : base[index] ?? fallback);
    if (next.some(value => value === undefined)) {rejected.push(name);continue;}
    if (!Object.hasOwn(values, parameter.name)) imported.push(parameter.name);
    values[parameter.name] = next;
  }
  return {values, imported, missing, rejected};
}

/**
 * Parses pasted or imported text and matches it to a row. Throws, changing
 * nothing, when the text holds no values for this shader.
 */
export function importShaderOptions(text, {parameters, values: current = {}, effectFile, source} = {}) {
  const options = selectShaderOptions(parseShaderOptions(text), effectFile);
  const result = matchShaderOptions(options, parameters || [], current);
  if (!result.imported.length) throw new Error(result.rejected.length
    ? `The values of ${list(result.rejected)} are outside what this shader accepts.`
    : `None of these options are in this shader: ${list(result.missing)}.`);
  const message = [`Imported ${plural(result.imported.length, "option")}${source ? ` from ${source}` : ""}`,
    ...(result.missing.length ? [`${result.missing.length} not found in this shader: ${list(result.missing)}`] : []),
    ...(result.rejected.length ? [`${result.rejected.length} with values this shader does not accept: ${list(result.rejected)}`] : [])].join("; ") + ".";
  return {...result, message};
}

/**
 * The row's current values as text in its native preset format, under source
 * names. A source name that two parameters share keeps the described name.
 */
export function formatShaderOptions({parameters, values = {}, effectFile}) {
  const format = shaderOptionsFormat(effectFile), counts = new Map();
  for (const parameter of parameters) counts.set(sourceName(parameter.name), (counts.get(sourceName(parameter.name)) || 0) + 1);
  const rows = parameters.map(parameter => [counts.get(sourceName(parameter.name)) === 1 ? sourceName(parameter.name) : parameter.name,
    Array.isArray(values[parameter.name]) ? values[parameter.name] : parameter.default]);
  if (format === "slangp") return rows.map(([name, numbers]) => `${name} = "${numbers[0]}"\n`).join("");
  const lines = rows.map(([name, numbers]) => `${name}=${numbers.join(",")}\n`).join("");
  return format === "reshade" ? `[${baseName(effectFile)}]\n${lines}` : lines;
}

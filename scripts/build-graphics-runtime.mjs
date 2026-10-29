#!/usr/bin/env node
// Builds the shared graphics runtime from owned sources, exact Git pins and
// declared binary inputs, then optionally stages it with stage-reshade.mjs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync, spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {createRequire} from "node:module";

const repository = path.resolve(import.meta.dirname, "..");
export const recipe = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "graphics-runtime.json"), "utf8"));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hash = file => digest(fs.readFileSync(file));
const canonical = url => String(url).replace(/\.git$/, "").replace(/\/$/, "");
const git = (directory, args) => execFileSync("git", ["-C", directory, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
const tryGit = (directory, args) => { try { return git(directory, args); } catch { return null; } };
// Toolchain flags from the caller's shell must not change compiled outputs.
const buildEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(DYLD_|RESHADE_|KLEPTON_|KL_)/.test(name) && !["CFLAGS", "CXXFLAGS", "OBJCFLAGS", "OBJCXXFLAGS", "CPPFLAGS", "LDFLAGS",
    "LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"].includes(name)));

function pointer(value, location) {
  for (const part of location.split("/").slice(1)) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw Error("Missing pinned field: " + location);
    value = value[key];
  }
  return value;
}
// Pins come from owned JSON records or the existing exports of owned build modules.
const loadModule = createRequire(import.meta.url);
function pinned({file, pointer: location = "", match, field}) {
  const target = path.join(repository, file);
  let value = pointer(/\.(?:c?js|mjs)$/.test(file) ? loadModule(target) : JSON.parse(fs.readFileSync(target, "utf8")), location);
  if (!match) return value;
  const rows = Array.isArray(value) ? value.filter(row => row && Object.entries(match).every(([key, expected]) => row[key] === expected)) : [];
  if (rows.length !== 1) throw Error("A pinned entry match must select exactly one record: " + file + location);
  return field ? pointer(rows[0], field) : rows[0];
}
const expand = (template, values) => template.replace(/\{([A-Za-z0-9.]+)\}/g, (_, key) => {
  const value = key.split(".").reduce((record, part) => record?.[part], values);
  if (typeof value !== "string") throw Error("Missing pinned field: " + key);
  return value;
});

/** Resolve a declared Git source against its exact pin and public origin. */
const gitlinks = new Map();
function recordedLinks(root) {
  if (!gitlinks.has(root)) {
    let rows = "";
    try { rows = execFileSync("git", ["-C", root, "ls-files", "-s"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024}); } catch {}
    gitlinks.set(root, new Map(rows.split("\n").flatMap(row => { const match = /^160000 ([a-f0-9]{40}) 0\t(.+)$/.exec(row); return match ? [[match[2], match[1]]] : []; })));
  }
  return gitlinks.get(root);
}
// A nested source is recorded by the Gitlink of its parent checkout.
function registration(relative, root = repository) {
  for (const [link, commit] of recordedLinks(root)) {
    if (link === relative) return {gitlink: commit};
    if (!relative.startsWith(link + "/")) continue;
    const child = path.join(root, link);
    return fs.existsSync(path.join(child, ".git")) ? registration(relative.slice(link.length + 1), child) : {gitlink: null, parent: path.relative(repository, child)};
  }
  return {gitlink: null};
}

export function resolveSource(id, override) {
  const entry = recipe.sources[id];
  if (!entry) throw Error("Unknown graphics source: " + id);
  const commit = pinned({file: entry.pin.file, pointer: entry.pin.commit}), origin = pinned({file: entry.pin.file, pointer: entry.pin.repository});
  const directory = override ? path.resolve(override) : path.join(repository, entry.path);
  const result = {id, path: directory, commit, repository: canonical(origin)};
  if (!override) {
    Object.assign(result, registration(entry.path));
    if (result.gitlink && result.gitlink !== commit) result.gitlinkDiffers = true;
  }
  if (!fs.existsSync(path.join(directory, ".git")))
    return {...result, state: result.gitlink || result.parent ? "uninitialized" : override ? "missing" : "unregistered"};
  const remote = tryGit(directory, ["remote", "get-url", "origin"]);
  if (canonical(remote) !== result.repository) return {...result, state: "different-origin", actual: remote};
  if (entry.match === "object") {
    if (tryGit(directory, ["rev-parse", "--verify", "--quiet", commit + "^{commit}"]) !== commit) return {...result, state: "missing-commit"};
    return {...result, state: "ready"};
  }
  const head = tryGit(directory, ["rev-parse", "HEAD"]);
  if (head !== commit) return {...result, state: "different-commit", actual: head};
  if (spawnSync("git", ["-C", directory, "diff", "--quiet", "--ignore-submodules=all", "HEAD", "--"]).status !== 0) return {...result, state: "modified"};
  return {...result, state: "ready"};
}

function inputLocation(id, work) {
  const entry = recipe.inputs[id], values = entry.pin ? pinned(entry.pin) : {};
  const directory = work && path.join(work, "inputs", id);
  // A package prefix combines several archives, each extracted into its own directory;
  // declared files are relative to the prefix.
  if (entry.kind === "archives") {
    const archives = values.map(row => Object.fromEntries(Object.entries(entry.each).map(([key, template]) => [key, expand(template, row)])));
    const files = Object.fromEntries(archives.filter(row => row.file).map(row => [row.file, row.fileSha256 || null]));
    return {entry, archives, files, directory, fetched: directory};
  }
  const url = entry.url && expand(entry.url, values), sha256 = entry.sha256 && expand(entry.sha256, values);
  const files = Object.fromEntries(Object.entries(entry.files || {}).map(([relative, expected]) => [relative, expected && expand(expected, values)]));
  const member = entry.entry === undefined ? null : expand(entry.entry, values), fileSha256 = entry.fileSha256 && expand(entry.fileSha256, values);
  const fetched = directory && (entry.kind === "archive" ? path.join(directory, member) : url && path.join(directory, path.basename(new URL(url).pathname)));
  return {entry, url, sha256, files, member, fileSha256, directory, fetched};
}
function verifyInput({entry, files = {}, fileSha256}, file, sha256) {
  if (!fs.existsSync(file)) return "missing";
  if (entry.kind === "file") return !sha256 || hash(file) === sha256 ? "ready" : "different-content";
  if (fs.statSync(file).isFile()) return fileSha256 && hash(file) === fileSha256 ? "ready" : "different-content";
  for (const [relative, expected] of Object.entries(files)) {
    const member = path.join(file, relative);
    if (!fs.existsSync(member) || (expected && hash(member) !== expected)) return "different-content";
  }
  return "ready";
}

/** Resolve a declared binary input, tool directory or build product. */
export function resolveInput(id, {overrides = {}, work, coreRoot = work && path.join(work, "core"), sources = {}, building = new Set()} = {}) {
  if (!recipe.inputs[id]) throw Error("Unknown graphics build input: " + id);
  const location = inputLocation(id, work), {entry, url, sha256, archives, fetched} = location;
  const declared = {id, kind: entry.kind, description: entry.description, ...(url ? {url} : {}), ...(sha256 ? {sha256} : {}),
    ...(archives ? {archives: archives.map(({url, sha256}) => ({url, sha256}))} : {})};
  const archiveSha256 = entry.kind === "file" ? sha256 : null;
  if (overrides[id]) { const file = path.resolve(overrides[id]); return {...declared, path: file, state: verifyInput(location, file, archiveSha256)}; }
  if (entry.from) {
    const source = sources[entry.from.source];
    if (source?.state === "ready") { const file = path.join(source.path, entry.from.path); return {...declared, path: file, state: verifyInput(location, file, null)}; }
    return {...declared, state: "source-" + (source?.state || "unselected"), source: entry.from.source};
  }
  if (entry.product) {
    const root = entry.product.provider === "core" ? coreRoot : work && path.join(work, "providers", entry.product.provider), file = root && path.join(root, entry.product.path);
    if (file && building.has(entry.product.provider)) return {...declared, path: file, state: "built-during-run"};
    return file && fs.existsSync(file) ? {...declared, path: file, state: verifyInput(location, file, null)} : {...declared, state: "missing", producer: entry.product.provider};
  }
  if (fetched && fs.existsSync(fetched)) return {...declared, path: fetched, state: verifyInput(location, fetched, archiveSha256)};
  return {...declared, state: url || archives?.every(row => row.url && row.sha256) ? "fetchable" : "missing"};
}

/** Download a pinned input into the work directory and verify its checksum. */
export async function fetchInput(id, work) {
  const {entry, url, sha256, archives, member, directory, fetched} = inputLocation(id, work);
  if (!(archives || [{url, sha256}]).every(row => row.url && row.sha256)) throw Error("This graphics input has no pinned download: " + id);
  if (fs.existsSync(fetched)) return fetched;
  const download = async (address, expected) => {
    const response = await fetch(address, {headers: entry.headers || {}});
    if (!response.ok) throw Error("Graphics input download failed (" + response.status + "): " + id);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== expected) throw Error("Graphics input checksum mismatch: " + id);
    return bytes;
  };
  // Archives extract into a staging directory that becomes the input only when complete.
  const staging = directory + ".partial";
  fs.rmSync(staging, {recursive: true, force: true});fs.mkdirSync(staging, {recursive: true});
  if (entry.kind === "file") fs.writeFileSync(path.join(staging, path.basename(fetched)), await download(url, sha256));
  for (const row of archives || (entry.kind === "archive" ? [{url, sha256, path: ""}] : [])) {
    const target = path.join(staging, row.path), archive = path.join(staging, ".download");
    fs.mkdirSync(target, {recursive: true});fs.writeFileSync(archive, await download(row.url, row.sha256));
    execFileSync("tar", ["-xf", archive, "-C", target, ...(entry.extract && member ? [member] : [])], {stdio: "inherit"});
    fs.rmSync(archive);
  }
  fs.rmSync(directory, {recursive: true, force: true});fs.renameSync(staging, directory);
  if (!fs.existsSync(fetched)) throw Error("The graphics input archive lacks its declared entry: " + id);
  return fetched;
}

function resolveTool(id, overrides) {
  if (overrides[id]) return {id, path: path.resolve(overrides[id]), state: fs.existsSync(overrides[id]) ? "ready" : "missing"};
  const found = spawnSync("/usr/bin/which", [recipe.tools[id].command], {encoding: "utf8"});
  return found.status === 0 ? {id, path: found.stdout.trim(), state: "ready"} : {id, state: "missing"};
}

const tokens = value => [...String(value).matchAll(/\{(source|input|tool):([^}]+)\}/g)].map(([, kind, id]) => ({kind, id}));
function requirements(id) {
  const provider = recipe.providers[id], needs = {source: new Set(provider.sources || []), input: new Set(), tool: new Set(provider.tools || [])};
  for (const step of provider.steps) for (const argument of step.args) for (const token of tokens(argument)) needs[token.kind].add(token.id);
  for (const input of needs.input) if (recipe.inputs[input].from) needs.source.add(recipe.inputs[input].from.source);
  return needs;
}

/** Resolve the complete build and staging plan without building. */
export function plan({work, only, skip = [], reuse = {}, sources: sourceOverrides = {}, inputs: inputOverrides = {}, tools: toolOverrides = {}} = {}) {
  if (work && !path.isAbsolute(work)) throw Error("Use an absolute graphics build directory.");
  const names = ["core", ...Object.keys(recipe.providers)];
  for (const name of [...(only || []), ...skip, ...Object.keys(reuse)]) if (!names.includes(name)) throw Error("Unknown graphics component: " + name);
  const selected = names.filter(name => (!only || only.includes(name)) && !skip.includes(name));
  const building = new Set(selected.filter(name => !reuse[name]));
  const needs = {source: new Set(), input: new Set(), tool: new Set()};
  for (const name of selected) {
    if (name === "core") { if (building.has("core")) needs.tool.add("cmake"); continue; }
    const provider = recipe.providers[name], own = requirements(name);
    if (provider.sourceOption) needs.source.add(provider.sourceOption[1]);
    if (building.has(name)) for (const kind of Object.keys(needs)) for (const value of own[kind]) needs[kind].add(value);
  }
  const coreRoot = reuse.core ? path.resolve(reuse.core) : work && path.join(work, "core");
  const core = coreRoot ? {source: path.join(coreRoot, "source"), build: path.join(coreRoot, "build"), ...(reuse.core ? {reused: true} : {})} : {};
  const sources = Object.fromEntries([...needs.source].sort().map(id => [id, resolveSource(id, sourceOverrides[id])]));
  const inputs = Object.fromEntries([...needs.input].sort().map(id => [id, resolveInput(id, {overrides: inputOverrides, work, coreRoot, sources, building})]));
  const tools = Object.fromEntries([...needs.tool].sort().map(id => [id, resolveTool(id, toolOverrides)]));
  const sdk = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], {encoding: "utf8"}).stdout?.trim();
  const unresolved = [];
  if (building.has("core") && (!sdk || sdk.localeCompare(recipe.core.macOSSDK, undefined, {numeric: true}) < 0)) unresolved.push("macOS SDK " + recipe.core.macOSSDK + " or later (found " + (sdk || "none") + ")");
  if (!work && building.size) unresolved.push("--work <absolute build directory>");
  const payloads = {}, steps = [];
  for (const name of selected.filter(name => name !== "core")) {
    const provider = recipe.providers[name];
    if (reuse[name]) { payloads[name] = path.resolve(reuse[name]); continue; }
    const root = work && path.join(work, "providers", name), values = {work: root && path.join(root, "work"), output: root && path.join(root, "output")};
    payloads[name] = root && path.join(root, provider.payload);
    for (const step of provider.steps) steps.push({provider: name, marker: path.join(payloads[name] || "", provider.marker || "provider.json"),
      argv: [path.join(repository, step.recipe), ...step.args.map(argument => argument.replace(/\{(work|output)\}|\{(source|input|tool|repo):([^}]+)\}/g, (_, local, kind, id) =>
        local ? values[local] ?? `<${local}>` : kind === "repo" ? path.join(repository, id) : (kind === "source" ? sources : kind === "input" ? inputs : tools)[id].path ?? `<${kind}:${id}>`))]});
  }
  for (const [kind, rows] of Object.entries({source: sources, input: inputs, tool: tools}))
    for (const row of Object.values(rows)) if (!["ready", "built-during-run"].includes(row.state)) unresolved.push(`${kind} ${row.id}: ${row.state}`);
  for (const [name, directory] of Object.entries(payloads)) if (reuse[name] && !fs.existsSync(path.join(directory, recipe.providers[name].marker || "provider.json"))) unresolved.push("reused payload " + name + ": missing metadata");
  if (reuse.core && !["libreshade-macos.dylib", "fx-compile"].every(file => fs.existsSync(path.join(core.build, file)))) unresolved.push("reused core: incomplete build");
  // Staging reads vendor notices and includes from a complete materialized
  // tree; a reused core may supply only its applied owned source.
  const stage = selected.includes("core") && core.build ? [path.join(repository, "scripts/stage-reshade.mjs"),
    work ? path.join(work, "core/source") : core.source, core.build, "--owned-source", core.source,
    ...Object.entries(payloads).flatMap(([name, directory]) => [recipe.providers[name].option, directory,
      ...(recipe.providers[name].sourceOption ? [recipe.providers[name].sourceOption[0], sources[recipe.providers[name].sourceOption[1]].path] : [])])] : null;
  return {work: work || null, selected, building: [...building], core, sdk: sdk || null, sources, inputs, tools, steps, payloads, stage, unresolved};
}

function syncTree(from, to) {
  const list = root => fs.existsSync(root) ? fs.readdirSync(root, {recursive: true}).filter(name => fs.lstatSync(path.join(root, name)).isFile()) : [];
  const wanted = new Set(list(from));
  for (const name of list(to)) if (!wanted.has(name)) fs.rmSync(path.join(to, name));
  for (const name of wanted) {
    const source = path.join(from, name), target = path.join(to, name), bytes = fs.readFileSync(source);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) continue;
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes); fs.chmodSync(target, fs.statSync(source).mode & 0o777);
  }
}

async function materializeCore(work) {
  const {materializeSource} = await import(pathToFileURL(path.join(repository, recipe.core.materialize)).href);
  const source = path.join(work, "core/source"), fresh = path.join(work, "core/source." + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(path.dirname(source), {recursive: true});
  // Unchanged files keep their timestamps, so a repeated build stays incremental.
  try { materializeSource({output: fresh}); syncTree(fresh, source); } finally { fs.rmSync(fresh, {recursive: true, force: true}); }
  return source;
}

/** Materialize the owned core source and build its CMake production targets.
 * With tests, the same build also produces the native fixtures under build/test. */
export async function buildCore({work, jobs = 4, tests = false}) {
  const source = await materializeCore(work), build = path.join(work, "core/build");
  const env = buildEnvironment(), run = args => execFileSync("cmake", args, {stdio: "inherit", env});
  const configure = {...recipe.core.configure, ...(tests ? {BUILD_TESTING: "ON", MACLAUNCHER_FIXTURE_DIR: path.join(repository, path.dirname(recipe.core.materialize), "test")} : {})};
  run(["-S", source, "-B", build, ...Object.entries(configure).map(([name, value]) => `-D${name}=${value}`)]);
  run(["--build", build, "--target", ...recipe.core.targets, ...(tests ? ["native-fixtures"] : []), "-j", String(jobs)]);
  return {source, build};
}

/** Execute a resolved plan: core, provider recipes and optional staging. */
export async function build(options) {
  const resolved = plan(options);
  if (resolved.unresolved.length) throw Error("Unresolved graphics build inputs:\n  " + resolved.unresolved.join("\n  "));
  if (options.tests && !resolved.building.includes("core")) throw Error("Native fixtures build with the core component.");
  if (resolved.building.includes("core")) await buildCore({work: resolved.work, jobs: options.jobs, tests: options.tests});
  else if (resolved.stage && resolved.work) await materializeCore(resolved.work);
  // A provider whose payload metadata existed before this run is complete;
  // remove its directory under the work root to rebuild it.
  const env = buildEnvironment(), completed = new Set(resolved.steps.filter(step => fs.existsSync(step.marker)).map(step => step.provider));
  for (const name of completed) console.log("Reusing completed graphics provider: " + name);
  for (const step of resolved.steps.filter(step => !completed.has(step.provider))) {
    fs.mkdirSync(path.join(resolved.work, "providers", step.provider), {recursive: true});
    execFileSync(process.execPath, step.argv, {cwd: repository, stdio: "inherit", env});
  }
  if (options.stage) execFileSync(process.execPath, resolved.stage, {cwd: repository, stdio: "inherit"});
  return resolved;
}

function parse(argv) {
  const options = {reuse: {}, sources: {}, inputs: {}, tools: {}, skip: []}, pairs = {"--reuse": "reuse", "--source": "sources", "--input": "inputs", "--tool": "tools"};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (["--check", "--fetch", "--stage", "--tests"].includes(key)) { options[key.slice(2)] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw Error("Missing value for " + key);
    if (pairs[key]) {
      const [name, location] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
      if (!name || !location || value.indexOf("=") < 1) throw Error(`Use ${key} id=path`);
      options[pairs[key]][name] = path.resolve(location);
    } else if (key === "--work") options.work = path.resolve(value);
    else if (key === "--jobs") { options.jobs = Number(value); if (!Number.isSafeInteger(options.jobs) || options.jobs < 1 || options.jobs > 64) throw Error("Use between 1 and 64 build jobs."); }
    else if (key === "--only" || key === "--skip") options[key.slice(2)] = value.split(",").filter(Boolean);
    else throw Error("Usage: node scripts/build-graphics-runtime.mjs [--check] --work DIR [--jobs N] [--only a,b] [--skip a,b] [--reuse id=DIR] [--source id=DIR] [--input id=PATH] [--tool id=PATH] [--fetch] [--stage] [--tests]");
  }
  return options;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  const options = parse(process.argv.slice(2));
  if (options.fetch) {
    if (!options.work) throw Error("Fetching requires --work.");
    const resolved = plan(options);
    for (const row of Object.values(resolved.inputs)) if (row.state === "fetchable") console.log("Fetched " + row.id + ": " + await fetchInput(row.id, options.work));
  }
  if (options.check) {
    const resolved = plan(options);
    console.log(JSON.stringify(resolved, null, 2));
    process.exitCode = resolved.unresolved.length ? 1 : 0;
  } else {
    const resolved = await build(options);
    console.log(JSON.stringify({work: resolved.work, core: resolved.core, payloads: resolved.payloads, stage: resolved.stage}, null, 2));
  }
}

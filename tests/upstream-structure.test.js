// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
// Sources declared with a field their kind has no place for, recorded by
// wrapping the factories before any module creates a source.
const Upstream = require("../src/modules/shared/runtime/upstream"), extraFields = [];
for (const [kind, fields] of Object.entries(Upstream.KINDS)) {
  const create = Upstream[kind];
  Upstream[kind] = spec => {
    for (const key of Object.keys(spec || {})) if (!fields.includes(key)) extraFields.push(`${kind}.${key}`);
    return create(spec);
  };
}
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

// Run-time downloads have two homes. Upstream publishers are reached only
// through src/modules/shared/runtime/upstream.js; MacLauncher Builds packages
// through the Builds catalog. Files inside the app are never downloaded.
const SRC = path.join(__dirname, "..", "src"), RUNTIME = path.join(SRC, "modules", "shared", "runtime");
const SHARED_LAYER = new Set(["upstream.js", "upstream-transport.js", "github-transport.js", "github-releases.js",
  "github-runtime-catalog.js", "github-actions-catalog.js", "github-web.js", "github-cli.js", "maclauncher-builds.js",
  "project-native-package.js", "pinned-native-manager.js"].map(name => path.join(RUNTIME, name))
  // The backend process hands GitHub requests to the transport in the main process.
  .concat(["backend-worker.js", "backend-worker-client.js"].map(name => path.join(SRC, "core", name))));
const NETWORK_FILES = new Set(["upstream-transport.js", "github-transport.js", "github-releases.js", "github-runtime-catalog.js",
  "github-actions-catalog.js", "github-web.js"].map(name => path.join(RUNTIME, name)));
const NETWORK_MODULES = new Set(["http", "https", "node:http", "node:https", "undici", "http2", "node:http2"]);
const TRANSPORT_NAMES = new Set(["fetchUrlBuffer", "downloadToFile"]);
// Code that runs inside a game page or the renderer, not in the launcher.
const PAGE_CODE = /\/(renderer|preload|patched|injected|website)\//;

function sources(directory, found = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { if (!["external", "node_modules", "resources"].includes(item.name)) sources(file, found); }
    else if (/\.(c?js|mjs)$/.test(item.name) && !PAGE_CODE.test(file)) found.push(file);
  }
  return found;
}
function resolveRequire(from, request) {
  if (!request.startsWith(".")) return request;
  const base = path.resolve(path.dirname(from), request);
  return [base, `${base}.js`, `${base}.cjs`, path.join(base, "index.js")].find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || base;
}
// Network use found in a file's syntax tree: the shared network modules it
// requires, client requests through Node's HTTP modules or undici (a local
// server is not a download), global fetch calls and the transport function
// names it reads.
function networkUse(file, parseAst) {
  let tree;
  try { tree = parseAst(fs.readFileSync(file, "utf8"), { lang: "js" }); } catch { return []; }
  const found = new Set(), name = node => node?.type === "Identifier" ? node.name : node?.type === "Literal" ? String(node.value) : null;
  const CLIENT = new Set(["request", "get", "fetch", "stream"]), clients = new Set(), calls = new Set();
  const networkRequire = node => node?.type === "CallExpression" && name(node.callee) === "require" && NETWORK_MODULES.has(node.arguments?.[0]?.value);
  const bind = node => {
    if (node.type !== "VariableDeclarator" || !networkRequire(node.init)) return;
    if (node.id.type === "Identifier") clients.add(node.id.name);
    for (const property of node.id.properties || []) if (CLIENT.has(name(property.key))) calls.add(name(property.value));
  };
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (node.type === "CallExpression") {
      const callee = node.callee, [first] = node.arguments || [];
      if (name(callee) === "require" && first?.type === "Literal" && typeof first.value === "string") {
        const target = resolveRequire(file, first.value);
        if (NETWORK_FILES.has(target)) found.add(`requires ${path.basename(target)}`);
      }
      if (callee?.type === "Identifier" && callee.name === "fetch" || callee?.type === "MemberExpression" && name(callee.property) === "fetch" &&
        ["globalThis", "global", "window", "undici", "net"].includes(name(callee.object))) found.add("calls fetch");
    }
    if (node.type === "CallExpression" && (calls.has(name(node.callee)) || node.callee?.type === "MemberExpression" &&
      CLIENT.has(name(node.callee.property)) && (clients.has(name(node.callee.object)) || networkRequire(node.callee.object)))) found.add("sends HTTP requests");
    if (node.type === "MemberExpression" && TRANSPORT_NAMES.has(name(node.property))) found.add(`uses ${name(node.property)}`);
    if (node.type === "Property" && node.value && TRANSPORT_NAMES.has(name(node.key)) && node.value.type !== "FunctionExpression" &&
      node.value.type !== "ArrowFunctionExpression") found.add(`uses ${name(node.key)}`);
    for (const [key, value] of Object.entries(node)) if (key !== "type" && value && typeof value === "object") visit(value);
  };
  const collect = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) collect(item); return; }
    bind(node);
    for (const [key, value] of Object.entries(node)) if (key !== "type" && value && typeof value === "object") collect(value);
  };
  collect(tree);
  visit(tree);
  return [...found];
}

test("only the shared download layer reaches the network", async () => {
  const { parseAst } = await import("rolldown/parseAst"), outside = [];
  for (const file of sources(SRC)) {
    if (SHARED_LAYER.has(file)) continue;
    const use = networkUse(file, parseAst);
    if (use.length) outside.push(`${path.relative(SRC, file)}: ${use.join(", ")}`);
  }
  assert.deepEqual(outside, [], "Files that download without an upstream source");
});

test("every upstream source is declared with its kind's fields only", () => {
  const registry = require("../src/modules/registry");
  for (const info of registry.listModules()) registry.getModule(info.id);
  registry.listSharedRuntimeManagers();
  assert.deepEqual(extraFields, [], "Fields an upstream source has no place for");
});

test("every manager that reads an upstream publisher does so through an upstream source", { skip: process.platform !== "darwin" }, async t => {
  const registry = require("../src/modules/registry"), userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-structure-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const managers = new Map();
  for (const info of registry.listModules()) for (const manager of registry.getModule(info.id)?.runtimeManagers || []) if (manager?.id) managers.set(manager.id, manager);
  for (const manager of registry.listSharedRuntimeManagers()) if (manager?.id) managers.set(manager.id, manager);
  const BUILDS = /^https:\/\/(?:raw\.githubusercontent\.com|api\.github\.com\/repos|github\.com)\/procrastinine\/maclauncher-builds\//;
  const missing = [];
  for (const [id, manager] of managers) {
    if (typeof manager.refreshCatalog !== "function") continue;
    const before = Harness.network.requests.length;
    Harness.network.routes = {};
    await manager.refreshCatalog({ userDataDir, force: true }).catch(() => {});
    Harness.network.routes = null;
    const upstream = Harness.network.requests.slice(before).filter(url => !BUILDS.test(url));
    // A manager names its source as `upstream`, or several in an array.
    const declared = [].concat(manager.upstream || []);
    if (upstream.length && (!declared.length || !declared.every(source => source?.kind))) missing.push(id);
  }
  assert.deepEqual(missing.sort(), [], "Managers that list upstream releases without an upstream source");
});

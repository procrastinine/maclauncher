// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
// Sources declared with a field their kind has no place for, recorded by
// wrapping the factories before any module creates a source.
const Upstream = require("../src/modules/shared/runtime/upstream"), extraFields = [];
const sourceOperation = new (require("node:async_hooks").AsyncLocalStorage)();
for (const [kind, fields] of Object.entries(Upstream.KINDS)) {
  const create = Upstream[kind];
  Upstream[kind] = spec => {
    for (const key of Object.keys(spec || {})) if (!fields.includes(key)) extraFields.push(`${kind}.${key}`);
    const source = create(spec);
    return Object.freeze(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, typeof value !== "function" ? value
      : Object.assign(function (...args) { return sourceOperation.run(source, () => value.apply(source, args)); }, value)])));
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
  const CLIENT = new Set(["request", "get", "fetch", "stream"]), clients = new Set(), calls = new Set(), parserFetch = new WeakMap();
  const networkRequire = node => node?.type === "CallExpression" && name(node.callee) === "require" && NETWORK_MODULES.has(node.arguments?.[0]?.value);
  const bind = node => {
    if (node.type !== "VariableDeclarator") return;
    if (!networkRequire(node.init)) return;
    if (node.id.type === "Identifier") clients.add(node.id.name);
    for (const property of node.id.properties || []) if (CLIENT.has(name(property.key))) calls.add(name(property.value));
  };
  const binds = (pattern, value) => pattern?.type === "Identifier" ? pattern.name === value : pattern?.type === "ObjectPattern"
    ? pattern.properties.some(property => binds(property.value || property.argument, value)) : pattern?.type === "ArrayPattern"
      ? pattern.elements.some(item => binds(item, value)) : ["AssignmentPattern", "RestElement"].includes(pattern?.type) && binds(pattern.left || pattern.argument, value);
  const reassigned = (node, binding) => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(item => reassigned(item, binding));
    if (node.type === "AssignmentExpression" && binds(node.left, binding) || node.type === "UpdateExpression" && binds(node.argument, binding)) return true;
    return Object.entries(node).some(([key, value]) => key !== "type" && value && typeof value === "object" && reassigned(value, binding));
  };
  const visit = (node, scopedFetch = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, scopedFetch); return; }
    if (["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type)) {
      const binding = parserFetch.get(node);
      if (binding) scopedFetch = reassigned(node.body, binding) ? null : binding;
      else if (scopedFetch && node.params.some(parameter => binds(parameter, scopedFetch))) scopedFetch = null;
    }
    if (node.type === "BlockStatement" && scopedFetch && node.body.some(statement => statement.type === "VariableDeclaration" &&
      statement.declarations.some(declaration => binds(declaration.id, scopedFetch)))) scopedFetch = null;
    if (node.type === "CallExpression") {
      const callee = node.callee, [first] = node.arguments || [];
      if (name(callee) === "require" && first?.type === "Literal" && typeof first.value === "string") {
        const target = resolveRequire(file, first.value);
        if (NETWORK_FILES.has(target)) found.add(`requires ${path.basename(target)}`);
      }
      if (callee?.type === "Identifier" && callee.name === "fetch" && scopedFetch !== "fetch" || callee?.type === "MemberExpression" && name(callee.property) === "fetch" &&
        ["globalThis", "global", "window", "undici", "net"].includes(name(callee.object))) found.add("calls fetch");
    }
    if (node.type === "CallExpression" && (calls.has(name(node.callee)) || node.callee?.type === "MemberExpression" &&
      CLIENT.has(name(node.callee.property)) && (clients.has(name(node.callee.object)) || networkRequire(node.callee.object)))) found.add("sends HTTP requests");
    if (node.type === "MemberExpression" && TRANSPORT_NAMES.has(name(node.property))) found.add(`uses ${name(node.property)}`);
    if (node.type === "Property" && node.value && TRANSPORT_NAMES.has(name(node.key)) && node.value.type !== "FunctionExpression" &&
      node.value.type !== "ArrowFunctionExpression") found.add(`uses ${name(node.key)}`);
    for (const [key, value] of Object.entries(node)) if (key !== "type" && value && typeof value === "object") visit(value, scopedFetch);
  };
  const collect = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) collect(item); return; }
    bind(node);
    for (const [key, value] of Object.entries(node)) if (key !== "type" && value && typeof value === "object") collect(value);
  };
  collect(tree);
  // Only index parsers receive the host-restricted fetch helper. A similarly
  // named parameter on another callback does not establish that provenance.
  const setBinding = (pattern, bindings, source = false) => {
    if (pattern?.type === "Identifier") bindings.set(pattern.name, source);
    else if (pattern?.type === "ObjectPattern") for (const property of pattern.properties) setBinding(property.value || property.argument, bindings);
    else if (pattern?.type === "ArrayPattern") for (const item of pattern.elements) setBinding(item, bindings);
    else if (["AssignmentPattern", "RestElement"].includes(pattern?.type)) setBinding(pattern.left || pattern.argument, bindings);
  };
  const sourceBinding = declaration => declaration.id.type === "Identifier" && declaration.init?.type === "CallExpression" &&
    name(declaration.init.callee) === "require" && typeof declaration.init.arguments?.[0]?.value === "string" &&
    resolveRequire(file, declaration.init.arguments[0].value) === path.join(RUNTIME, "upstream.js");
  const parsers = (node, bindings = new Map()) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) parsers(item, bindings);return; }
    if (["Program", "BlockStatement"].includes(node.type)) {
      bindings = new Map(bindings);
      for (const statement of node.body) {
        if (statement.type === "VariableDeclaration") for (const declaration of statement.declarations) setBinding(declaration.id, bindings, sourceBinding(declaration));
        else if (["FunctionDeclaration", "ClassDeclaration"].includes(statement.type)) setBinding(statement.id, bindings);
      }
    }
    if (["FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression"].includes(node.type)) {
      bindings = new Map(bindings);setBinding(node.id, bindings);
      for (const parameter of node.params) setBinding(parameter, bindings);
    }
    if (node.type === "CatchClause") { bindings = new Map(bindings);setBinding(node.param, bindings); }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" &&
      bindings.get(name(node.callee.object)) === true && name(node.callee.property) === "index") {
      const callback = node.arguments[0]?.properties?.find(property => name(property.key) === "parse")?.value;
      const fetch = callback?.params?.[1]?.properties?.find(property => name(property.key) === "fetch")?.value;
      if (fetch?.type === "Identifier") parserFetch.set(callback, fetch.name);
    }
    for (const [key, value] of Object.entries(node)) if (key !== "type" && value && typeof value === "object") parsers(value, bindings);
  };
  parsers(tree);
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
  const observed = observePublisherRequests(t), missing = [];
  for (const [id, manager] of managers) {
    if (typeof manager.refreshCatalog !== "function") continue;
    const before = observed.length;
    Harness.network.routes = {};
    await manager.refreshCatalog({ userDataDir, force: true }).catch(() => {});
    Harness.network.routes = null;
    const unscoped = observed.slice(before).filter(row => !BUILDS.test(row.url) && !row.kind);
    if (unscoped.length) missing.push(id);
  }
  assert.deepEqual(missing.sort(), [], "Managers that list upstream releases without an upstream source");
});


function observePublisherRequests(t) {
  const observed = [], original = Harness.network.requests;
  const requests = new Proxy(original, {get(target, key, receiver) {
    if (key !== "push") return Reflect.get(target, key, receiver);
    return (...urls) => {
      for (const url of urls) observed.push({url: String(url), kind: sourceOperation.getStore()?.kind || null});
      return Array.prototype.push.apply(target, urls);
    };
  }});
  Harness.network.requests = requests;
  t.after(() => {if (Harness.network.requests === requests) Harness.network.requests = original;});
  return observed;
}

test("network syntax checks distinguish index parser bindings from global or unrelated fetch", async t => {
  const {parseAst} = await import("rolldown/parseAst"), root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-binding-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, "source.js"), upstream = JSON.stringify(path.relative(root, path.join(RUNTIME, "upstream.js")));
  const inspect = source => {fs.writeFileSync(file, source);return networkUse(file, parseAst);};
  const head = 'const Provider = require(' + upstream + ');';
  assert.deepEqual(inspect(head + 'Provider.index({parse: async (documents, {fetch}) => {await Promise.resolve();return fetch("https://publisher.invalid/");}});'), []);
  assert.deepEqual(inspect(head + 'Provider.index({parse: async (documents, {fetch}) => globalThis.fetch("https://publisher.invalid/")});'), ["calls fetch"]);
  assert.deepEqual(inspect(head + 'Provider.index({parse: async (documents, {fetch}) => ((fetch) => fetch("https://publisher.invalid/"))(globalThis.fetch)});'), ["calls fetch"]);
  assert.deepEqual(inspect('const Other = {};Other.index({parse: async (documents, {fetch}) => fetch("https://publisher.invalid/")});'), ["calls fetch"]);
  assert.deepEqual(inspect(head + 'Provider.index({parse: async (documents, {fetch}) => []});fetch("https://publisher.invalid/");'), ["calls fetch"]);
  assert.deepEqual(inspect(head + 'function nested(Provider) {return Provider.index({parse: async (documents, {fetch}) => fetch("https://publisher.invalid/")});}'), ["calls fetch"]);
  assert.deepEqual(inspect(head + 'Provider.index({parse: async (documents, {fetch}) => {fetch = globalThis.fetch;return fetch("https://publisher.invalid/");}});'), ["calls fetch"]);
});

test("publisher provenance follows source operations and rejects unscoped requests despite source labels", async t => {
  const observed = observePublisherRequests(t), transport = require("../src/modules/shared/runtime/upstream-transport");
  const location = "https://publisher.invalid/", source = Upstream.index({locations: [location], hosts: ["publisher.invalid"], parse: async () => {await Promise.resolve();return [];}});
  Harness.network.routes = {[location]: "publisher index"};t.after(() => {Harness.network.routes = null;});
  await source.discover();assert.deepEqual(observed, [{url: location, kind: "index"}]);
  const unscoped = {upstream: {kind: "index"}, refreshCatalog: () => transport.fetchUrlBuffer(location)};
  await unscoped.refreshCatalog();assert.deepEqual(observed.at(-1), {url: location, kind: null}, "A declared-looking label cannot authorize an unscoped transport request");
});

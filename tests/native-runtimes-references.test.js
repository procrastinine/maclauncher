const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ID = "[a-z0-9][a-z0-9-]*";
// The declaration-scoped resolver is the one module that names the bare
// application resource root; everything it returns is filtered by declarations.
const RESOLVER = "src/modules/shared/runtime/included-helpers.js";
// Lookups that are not yet declaration-scoped. Each entry names its owner and
// the exact number of lookup lines; the list may only shrink.
const REMAINING = [
  { file: "src/modules/shared/reshade/index.js", sites: 1, owner: "graphics runtime (Codex 01a1715f)",
    reason: "The graphics core root is searched in Resources and then src/resources rather than through its declaration." },
  { file: "src/modules/shared/reshade/publication.js", sites: 1, owner: "graphics runtime (Codex 01a1715f)",
    reason: "The publication reader receives the same Resources and src/resources roots." },
  { file: "src/modules/shared/runtime/bundled-native.js", sites: 2, owner: "graphics runtime (Codex 01a1715f)",
    reason: "Default bundle roots are the whole native-runtimes trees of Resources and src/resources." }
];

// Every native-runtimes location named on a line: a literal path, a path.join
// segment, a declaration-style directoryRelative, a bundled runtime manager id
// or an included-helper id.
function runtimeReferences(text) {
  const found = [];
  for (const match of text.matchAll(/["'`][^"'`\n]*?native-runtimes\/([^"'`\n/]*)/g))
    found.push(match[1].startsWith("${") ? { dynamic: match[0] } : { id: match[1] });
  for (const match of text.matchAll(/["'`]native-runtimes["'`]\s*(?:,\s*([^,)]+))?/g)) {
    const next = match[1]?.trim();
    if (!next) continue;
    const literal = next.match(new RegExp(`^["'\`](${ID})`));
    found.push(literal ? { id: literal[1] } : { dynamic: next });
  }
  for (const match of text.matchAll(new RegExp(`directoryRelative\\s*[:=]\\s*["'\`](${ID})/`, "g"))) found.push({ id: match[1] });
  for (const match of text.matchAll(new RegExp(`createBundledNativeRuntime\\(\\s*\\{[^}]*?managerId:\\s*["'\`](${ID})["'\`]`, "g")))
    found.push({ id: match[1] });
  for (const match of text.matchAll(new RegExp(`resolveIncluded\\([^;]*?\\bid:\\s*["'\`](${ID})["'\`]`, "g"))) found.push({ id: match[1], included: true });
  return found;
}

function acceptedReference(reference, { declared, managers }) {
  if (reference.included) return declared.has(reference.id);
  if (reference.id) return declared.has(reference.id) || managers.has(reference.id);
  // A computed location must come from a packaging declaration.
  return /\bdirectoryRelative\b/.test(reference.dynamic);
}

// A location in the application's Resources directory is declared when the
// package configuration places it there.
function packagedLocation(segments, packaging) {
  if (segments[0] === "native-runtimes") return segments.length > 1;
  if (segments[0] === "app.asar.unpacked") return segments.length > 1 && packaging.unpacked.some(pattern => path.matchesGlob(segments.slice(1).join("/"), pattern));
  return segments.length > 0 && packaging.resources.has(segments[0]);
}

function legacySupplierRoot(segments, packaging) {
  // Upstream asset readers also retain these root candidates from older app
  // layouts. They are plumbing for the declared external supplier namespace,
  // not individual file or native-runtime references.
  return packaging.resources.has("external") &&
    ["app.asar.unpacked/external", "app.asar.unpacked/src/external"].includes(segments.join("/"));
}

// The stock supplier reader funnels literal Python/evbunpack paths through a
// private helper with the original packaged/unpacked layout alternatives.
// Validate those call sites rather than treating its spread argument as an
// undeclared runtime. Native-runtime references are still checked separately.
function supplierResourcePlumbing(file, source, packaging) {
  if (file !== "src/modules/shared/runtime/python.js" ||
      !/^function resolvePackagedResourcePath\(\.\.\.segments\) \{/m.test(source) ||
      /module\.exports\s*=[\s\S]*\bresolvePackagedResourcePath\b/.test(source)) return false;
  const calls = [...source.matchAll(/\bresolvePackagedResourcePath\((?!\.\.\.segments)([^)]*)\)/g)];
  return calls.length > 0 && calls.every(([, argumentsText]) => {
    const segments = argumentsText.split(",").map(value => /^["']([^"']+)["']$/.exec(value.trim())?.[1]);
    if (segments.some(value => !value)) return false;
    if (["resources", "src"].includes(segments[0])) segments.shift();
    return packagedLocation(segments, packaging);
  });
}

/** Lines that look up native-runtimes, the application Resources directory or src/resources without a declaration. */
function undeclaredLookups(file, source, known) {
  const problems = [];
  const supplierPlumbing = supplierResourcePlumbing(file, source, known.packaging);
  source.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\*)/.test(line)) return;
    const reasons = [];
    for (const reference of runtimeReferences(line)) if (!acceptedReference(reference, known)) reasons.push(`native-runtimes ${JSON.stringify(reference)}`);
    if (/\[\s*process\.resourcesPath\s*,/.test(line)) reasons.push("searches Resources among other roots");
    for (const match of line.matchAll(/path\.(?:join|resolve)\(\s*process\.resourcesPath\s*(?:,([^)]*))?\)/g)) {
      if (supplierPlumbing && /^\s*path\.join\(process\.resourcesPath,\s*(?:"app\.asar\.unpacked",\s*(?:"src",\s*)?)?\.\.\.segments\),?$/.test(line)) continue;
      const segments = [];
      for (const argument of (match[1] || "").split(",").map(value => value.trim())) {
        const literal = argument.match(/^["'`]([^"'`$]+)["'`]$/);
        if (!literal) break;
        segments.push(...literal[1].split("/").filter(Boolean));
      }
      if (!packagedLocation(segments, known.packaging) && !legacySupplierRoot(segments, known.packaging)) reasons.push(`Resources/${segments.join("/")} is not a packaged location`);
    }
    for (const match of line.matchAll(/["'`]((?:\.\.\/)+[^"'`$]*)["'`]/g)) {
      const relative = path.relative(path.join(ROOT, "src/resources"), path.resolve(path.dirname(path.join(ROOT, file)), match[1]));
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const segments = relative.split(path.sep).filter(Boolean);
      if (!packagedLocation(segments, known.packaging) || segments[0] === "app.asar.unpacked") reasons.push(`src/resources/${segments.join("/")} is not a packaged location`);
    }
    if (reasons.length) problems.push({ file, line: index + 1, reasons });
  });
  return problems;
}

function applicationSources() {
  const selected = require("../scripts/check-packaging.cjs").applicationFileSelector(require("../package.json"));
  const files = [];
  (function walk(relative) {
    for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const item = relative + "/" + entry.name;
      if (entry.isDirectory()) { if (!["src/external", "src/renderer"].includes(item)) walk(item); }
      else if (/\.(?:c?js|mjs)$/.test(entry.name) && selected(item)) files.push(item);
    }
  })("src");
  return files;
}

function packagingLocations(build = require("../package.json").build) {
  const resources = new Set();
  for (const entry of build.extraResources || []) {
    if (entry.to && entry.to !== ".") resources.add(entry.to.split("/")[0]);
    else for (const name of entry.filter || []) {
      const root = name.split("/")[0];
      if (root && !/[!*?{\[\]]/.test(root)) resources.add(root);
    }
  }
  return { resources, unpacked: build.asarUnpack || [] };
}

function knownIdentities() {
  const Supplementals = require("../scripts/native-supplementals.cjs"), Modules = require("../src/modules/registry");
  const items = Supplementals.declarations();
  const managers = [...Modules.listSharedRuntimeManagers(), ...Modules.listModules().flatMap(info => Modules.getModule(info.id)?.runtimeManagers || [])];
  return { items, declared: new Set(items.map(item => item.id)), managers: new Set(managers.map(manager => manager.id)), packaging: packagingLocations() };
}

test("the lookup scan reports undeclared native-runtimes, Resources and src/resources locations", () => {
  const known = { declared: new Set(["declared-helper"]), managers: new Set(["managed-engine"]),
    packaging: { resources: new Set(["launcher.png", "tools"]), unpacked: ["src/modules/example/*.py"] } };
  const file = "src/modules/example/runtime/lookup.js";
  const rejected = [
    'path.join(process.resourcesPath, "native-runtimes", "made-up-helper")',
    'path.resolve(__dirname, "../../../resources/native-runtimes/made-up-helper/1.0/universal")',
    'path.join(root, "native-runtimes", helperName, version)',
    'const directoryRelative = `made-up-helper/${VERSION}/universal`;',
    'createBundledNativeRuntime({ managerId: "made-up-helper" })',
    'Included.resolveIncluded(declarations, { id: "managed-engine", version })',
    'process.resourcesPath && path.join(process.resourcesPath, "native-runtimes")',
    'candidates.push(path.join(process.resourcesPath, "resources", "tools"))',
    'path.join(process.resourcesPath, "app.asar.unpacked", "src", "modules", "example", "other.js")',
    'resolveRoot([process.resourcesPath, root])',
    'path.resolve(__dirname, "../../../resources")'
  ];
  for (const source of rejected) assert.equal(undeclaredLookups(file, source, known).length, 1, source);
  const accepted = [
    'path.join(root, "native-runtimes", "declared-helper", version)',
    'path.join(resourcesRoot, "native-runtimes", pin.directoryRelative)',
    'path.join(resourcesRoot, "native-runtimes")',
    'createBundledNativeRuntime({ managerId: "managed-engine" })',
    'createBundledNativeRuntime({ managerId: "declared-helper", resourceRoot })',
    'Included.resolveIncluded(declarations, { id: "declared-helper", version })',
    'path.join(process.resourcesPath, "launcher.png")',
    'path.join(process.resourcesPath, "tools", "reader.py")',
    'path.join(process.resourcesPath, "app.asar.unpacked", "src", "modules", "example", "host.py")',
    'path.resolve(__dirname, "../../../resources/launcher.png")',
    'if (process.resourcesPath) roots.push(base)',
    '// path.join(process.resourcesPath, "native-runtimes", "made-up-helper")'
  ];
  for (const source of accepted) assert.deepEqual(undeclaredLookups(file, source, known), [], source);
  const packaging = packagingLocations({ extraResources: [{ to: ".", filter: ["python/**", "7zip/**", "!excluded/**", "**/*.tmp"] },
    { to: "external", filter: ["evbunpack/*.py"] }] });
  assert.deepEqual([...packaging.resources].sort(), ["7zip", "external", "python"]);
  const supplierFile = "src/modules/shared/runtime/python.js", supplierSource = fs.readFileSync(path.join(ROOT, supplierFile), "utf8");
  const supplierKnown = { ...known, packaging };
  for (const legacyRoot of ['"app.asar.unpacked", "external"', '"app.asar.unpacked", "src", "external"'])
    assert.deepEqual(undeclaredLookups(file, `path.join(process.resourcesPath, ${legacyRoot})`, supplierKnown), []);
  assert.equal(undeclaredLookups(file, 'path.join(process.resourcesPath, "app.asar.unpacked", "external", "undeclared.py")', supplierKnown).length, 1);
  assert.equal(undeclaredLookups(file, 'path.join(process.resourcesPath, "app.asar.unpacked", "undeclared-supplier")', supplierKnown).length, 1);
  assert.deepEqual(undeclaredLookups(supplierFile, supplierSource, supplierKnown), []);
  assert.ok(undeclaredLookups(supplierFile, supplierSource.replace('resolvePackagedResourcePath("python")', 'resolvePackagedResourcePath("undeclared-supplier")'), supplierKnown).length > 0);
});

test("every application lookup of packaged resources is declared, installed by a manager or listed with its owner", () => {
  const known = knownIdentities(), counts = new Map(), unlisted = [];
  for (const file of applicationSources()) {
    if (file === RESOLVER) continue;
    for (const problem of undeclaredLookups(file, fs.readFileSync(path.join(ROOT, file), "utf8"), known)) {
      counts.set(file, (counts.get(file) || 0) + 1);
      if (!REMAINING.some(entry => entry.file === file)) unlisted.push(`${file}:${problem.line} ${problem.reasons.join("; ")}`);
    }
  }
  assert.deepEqual(unlisted, []);
  // A resolved or changed site updates its entry, so the list only shrinks.
  assert.deepEqual(REMAINING.filter(entry => counts.get(entry.file) !== entry.sites)
    .map(entry => `${entry.file}: listed ${entry.sites}, found ${counts.get(entry.file) || 0}`), []);
});

test("included-helper lookups read only declarations that application packaging collects", () => {
  const { items } = knownIdentities(), collected = new Set(items.map(item => `${item.directoryRelative}:${item.manifestSha256}`)), problems = [];
  for (const file of applicationSources()) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (!/\bresolveIncluded\(/.test(source) || file === RESOLVER) continue;
    for (const match of source.matchAll(/require\(["'](\.[^"']+\.json)["']\)/g)) {
      const value = JSON.parse(fs.readFileSync(path.resolve(ROOT, path.dirname(file), match[1]), "utf8"));
      if (!Array.isArray(value) || !value.some(item => item?.directoryRelative && item?.manifestSha256)) continue;
      for (const item of value) if (!collected.has(`${item.directoryRelative}:${item.manifestSha256}`)) problems.push(`${file}: ${item.directoryRelative}`);
    }
  }
  assert.deepEqual(problems, []);
});

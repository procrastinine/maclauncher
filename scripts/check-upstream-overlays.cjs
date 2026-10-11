#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(__dirname, "upstream-overlays.json");
const LIMITS = Object.freeze({ files: 100000, bytes: 512 * 1024 * 1024, gitOutput: 32 * 1024 * 1024 });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function relativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /[\\\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw Error("Unsafe inventory source path.");
  return value;
}
function normalizedOrigin(value) {
  let text = String(value || "").trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git\/?$/, "").replace(/\/$/, "");
  const url = new URL(text);
  if (!["https:", "http:"].includes(url.protocol)) throw Error("Upstream origin must identify an HTTP(S) repository.");
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.href.replace(/\/$/, "");
}
function gitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"]) delete env[key];
  return env;
}
async function git(directory, args, { binary = false, maximum = LIMITS.gitOutput } = {}) {
  const result = await exec("git", ["-c", "core.fsmonitor=false", "-C", directory, ...args], {
    encoding: binary ? null : "utf8", maxBuffer: maximum, timeout: 60000, env: gitEnvironment()
  });
  return result.stdout;
}
async function blobs(directory, entries) {
  const maximum = entries.reduce((total, item) => total + item.bytes + 96, 0) + 1024;
  const output = await new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", "-C", directory, "cat-file", "--batch"],
      { encoding: null, maxBuffer: maximum, timeout: 60000, env: gitEnvironment() },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(entries.map(entry => entry.object).join("\n") + "\n");
    child.stdin.on("error", reject);
  });
  const result = []; let offset = 0;
  for (const entry of entries) {
    const newline = output.indexOf(10, offset);
    const header = output.subarray(offset, newline).toString("ascii");
    if (newline < 0 || header !== `${entry.object} blob ${entry.bytes}`) throw Error("Candidate blob identity or length differs from its Git tree.");
    offset = newline + 1;
    const bytes = output.subarray(offset, offset + entry.bytes); offset += entry.bytes;
    if (bytes.length !== entry.bytes || output[offset++] !== 10) throw Error("Candidate Git blob output is truncated.");
    result.push(bytes);
  }
  if (offset !== output.length) throw Error("Unexpected trailing candidate Git data.");
  return result;
}
function configRows(text) {
  const entries = new Map();
  for (const line of text.split("\n")) {
    const matched = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line);
    if (!matched) continue;
    const value = entries.get(matched[1]) || {};
    value[matched[2]] = matched[3]; entries.set(matched[1], value);
  }
  return [...entries.values()].map(value => ({ path: relativePath(value.path), repository: normalizedOrigin(value.url) }));
}
async function submodules(directory, revision) {
  const args = revision ? ["config", "--blob", `${revision}:.gitmodules`] : ["config", "--file", ".gitmodules"];
  try { return configRows(await git(directory, [...args, "--get-regexp", "^submodule\\..*\\.(path|url)$"])); }
  catch (error) { if ([1, 128].includes(error.code)) return []; throw error; }
}
async function indexLinks(directory) {
  const rows = (await git(directory, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
  return new Map(rows.flatMap(row => {
    const matched = /^160000 ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
    return matched ? [[matched[2], matched[1]]] : [];
  }));
}
async function treeLinks(directory, revision) {
  return new Map((await git(directory, ["ls-tree", "-rz", revision])).split("\0").filter(Boolean).flatMap(row => {
    const matched = /^160000 commit ([a-f0-9]{40})\t(.+)$/.exec(row);
    return matched ? [[matched[2], matched[1]]] : [];
  }));
}
function sourceRef(root, ref) {
  const file = path.join(root, relativePath(ref.path));
  if (!fs.statSync(file).isFile()) throw Error(`Missing pin evidence: ${ref.path}.`);
  if (ref.select !== undefined && ref.kind !== "json")
    throw Error(`Pin selection requires a JSON array and explicit record fields: ${ref.path}.`);
  let value;
  if (ref.kind === "literal") {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(ref.value)) throw Error(`Source evidence no longer contains its declared pin: ${ref.path}.`);
    return ref.value;
  }
  value = ref.kind === "json" ? JSON.parse(fs.readFileSync(file, "utf8")) : require(file);
  if (ref.select !== undefined) {
    if (!Array.isArray(value) || !ref.select || typeof ref.select !== "object" || Array.isArray(ref.select))
      throw Error(`Pin selection requires a JSON array and explicit record fields: ${ref.path}.`);
    const fields = Object.entries(ref.select);
    if (!fields.length || fields.some(([key, expected]) => !key || typeof expected !== "string" || !expected))
      throw Error(`Pin selection fields must contain explicit strings: ${ref.path}.`);
    const matches = value.filter(record => record && typeof record === "object" && fields.every(([key, expected]) => record[key] === expected));
    if (matches.length !== 1) throw Error(`Pin evidence requires exactly one selected record: ${ref.path}.`);
    value = matches[0];
  }
  for (const key of String(ref.property || "").split(".").filter(Boolean)) value = value?.[key];
  if (typeof value !== "string") throw Error(`Pin evidence does not expose a string: ${ref.path} ${ref.property}.`);
  return value;
}
function validateInventory(inventory) {
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.projects) || !Array.isArray(inventory.recipes)) throw Error("Unsupported upstream inventory schema.");
  const ids = new Set(), locations = new Set(), recipes = new Set();
  for (const project of inventory.projects) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(project.id || "") || ids.has(project.id) || !/^[a-f0-9]{40}$/.test(project.revision || "")) throw Error("Duplicate or invalid upstream project identity.");
    ids.add(project.id); normalizedOrigin(project.repository);
    if (project.checkoutOrigin !== undefined) {
      normalizedOrigin(project.checkoutOrigin);
      if (typeof project.checkoutOriginReason !== "string" || !project.checkoutOriginReason.trim() || project.checkoutOriginReason.length > 1024)
        throw Error("An explicit checkout mirror requires a recorded origin reason.");
    }
    if (project.path) {
      relativePath(project.path);
      if (locations.has(project.path)) throw Error("Duplicate upstream checkout path.");
      locations.add(project.path);
    }
  }
  for (const recipe of inventory.recipes) {
    const ownedHelper = recipe.kind === "owned-native-helper" && recipe.project === undefined;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(recipe.id || "") || recipes.has(recipe.id) || !ownedHelper && !ids.has(recipe.project)) throw Error("Duplicate or invalid source adaptation recipe.");
    if (recipe.kind === "owned-native-helper" && (!ownedHelper || !recipe.ownedFiles?.length || !recipe.version || !recipe.versionRefs?.length ||
      [recipe.operations, recipe.inputs, recipe.guards, recipe.pinRefs, recipe.includePaths, recipe.outputRoots].some(items => items?.length) ||
      recipe.revision || recipe.sourceScopes || recipe.sourceSubdirectory || recipe.reviewedOriginalFiles || recipe.reviewedAdaptedFiles))
      throw Error("An owned native helper requires exact owned/version evidence and cannot declare upstream Git operations.");
    recipes.add(recipe.id);
    if (recipe.version !== undefined && (typeof recipe.version !== "string" || !recipe.version)) throw Error("An adaptation version must be an explicit string.");
    if (recipe.revision && !/^[a-f0-9]{40}$/.test(recipe.revision)) throw Error("A source variant must have a full Git commit.");
    if (recipe.sourceSubdirectory) relativePath(recipe.sourceSubdirectory);
    for (const file of recipe.includePaths || []) relativePath(file);
    for (const [projectId, files] of Object.entries(recipe.sourceScopes || {})) {
      if (!ids.has(projectId) || !Array.isArray(files) || !files.length) throw Error("A source scope needs an inventoried project and paths.");
      files.forEach(relativePath);
    }
    for (const file of recipe.ownedFiles || []) {
      relativePath(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw Error("An owned adaptation needs its exact file SHA-256.");
    }
    for (const file of [...recipe.tests || [], ...recipe.buildEntries || []]) relativePath(file);
    for (const operation of recipe.operations || []) {
      if (!["call", "copy"].includes(operation.kind)) throw Error("Unknown owned source adaptation operation.");
      if (operation.kind === "call") relativePath(operation.module);
      if (operation.kind === "copy") { if (typeof operation.from === "string") relativePath(operation.from); relativePath(operation.to); }
    }
    for (const input of recipe.inputs || []) {
      if (!ids.has(input.project) || !/^[A-Za-z0-9_-]+$/.test(input.name || "")) throw Error("Unknown source input.");
      if (input.destination) relativePath(input.destination);
    }
    for (const guard of recipe.guards || []) for (const [file, expected] of Object.entries(guard.files || {})) {
      relativePath(file); if (!/^[a-f0-9]{64}$/.test(expected)) throw Error("A source guard needs its exact SHA-256.");
    }
    for (const files of [recipe.reviewedOriginalFiles, recipe.reviewedAdaptedFiles, ...(recipe.outputRoots || []).flatMap(output => [output.reviewedOriginalFiles, output.reviewedAdaptedFiles])]) {
      for (const [file, expected] of Object.entries(files || {})) {
        relativePath(file); if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) throw Error("Original and adapted files require SHA-256 values or declared absence.");
      }
    }
    for (const file of recipe.variableAdaptedFiles || []) relativePath(file);
  }
  return inventory;
}
function ownedAdaptationFiles(root, sourcePaths) {
  const result = [];
  function visit(directory, relative = "src/modules") {
    if (sourcePaths.has(relative)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative + "/" + entry.name;
      if ([".git", "native-runtimes", "__pycache__"].includes(entry.name)) continue;
      if (entry.isDirectory()) {
        if (name.includes("/resources/") && !name.endsWith("/unren") && !name.includes("/unren/")) continue;
        visit(path.join(directory, entry.name), name);
      } else if (entry.isFile() && (name.includes("/overlays/") || name.endsWith(".patch") || name.includes("/unren/patches/") || entry.name.endsWith("source-overlay.js"))) result.push(name);
    }
  }
  const directory = path.join(root, "src/modules"); if (fs.existsSync(directory)) visit(directory);
  return result.sort();
}
async function sourceGuardBlob({ root, project, revision, file, projects, depth = 0 }) {
  relativePath(file);
  if (depth > 16 || !/^[a-f0-9]{40}$/.test(revision)) throw Error("Invalid nested source guard identity.");
  const directory = path.join(root, project.path);
  try { return await git(directory, ["show", `${revision}:${file}`], { binary: true }); }
  catch (original) {
    const link = [...await treeLinks(directory, revision)].find(([name]) => file.startsWith(name + "/"));
    if (!link) throw original;
    const [name, commit] = link, nested = [...projects.values()].find(item =>
      item.path === project.path + "/" + name || item.parent === project.id && item.sourceSubdirectory === name);
    const declaration = (await submodules(directory, revision)).find(item => item.path === name);
    if (!nested?.path || !declaration || nested.revision !== commit ||
        normalizedOrigin(nested.repository) !== normalizedOrigin(declaration.repository)) {
      throw Error("Nested source guard differs from its inventoried Gitlink or origin.");
    }
    const child = path.join(root, nested.path);
    if (!fs.existsSync(path.join(child, ".git")) || normalizedOrigin(await git(child, ["remote", "get-url", "origin"])) !==
        normalizedOrigin(nested.checkoutOrigin || nested.repository)) throw Error("Nested source guard checkout is unavailable or has a different origin.");
    return sourceGuardBlob({ root, project: nested, revision: commit, file: file.slice(name.length + 1), projects, depth: depth + 1 });
  }
}
async function checkInventory({ root = ROOT, inventory = JSON.parse(fs.readFileSync(INVENTORY, "utf8")) } = {}) {
  validateInventory(inventory);
  const errors = [], warnings = [], checked = [];
  const projects = new Map(inventory.projects.map(project => [project.id, project]));
  const sourcePaths = new Set(inventory.projects.filter(project => project.path).map(project => project.path));
  const top = await submodules(root), links = await indexLinks(root);
  for (const module of top) if (!sourcePaths.has(module.path)) errors.push({ code: "untracked-upstream", path: module.path });
  for (const location of links.keys()) if (!sourcePaths.has(location)) errors.push({ code: "untracked-index-gitlink", path: location });
  for (const project of inventory.projects) {
    if (!project.path) { checked.push({ id: project.id, status: "explicit-build-input", revision: project.revision }); continue; }
    const directory = path.join(root, project.path);
    let declared, declaredOrigin, metadataAvailable = !project.parent;
    if (!project.parent) {
      declared = links.get(project.path); declaredOrigin = top.find(module => module.path === project.path)?.repository;
    } else {
      const parent = projects.get(project.parent);
      if (!parent?.path) { errors.push({ code: "missing-parent", id: project.id }); continue; }
      try {
        const relative = path.posix.relative(parent.path, project.path), parentDirectory = path.join(root, parent.path);
        declared = (await treeLinks(parentDirectory, parent.revision)).get(relative);
        declaredOrigin = (await submodules(parentDirectory, parent.revision)).find(module => module.path === relative)?.repository;
        metadataAvailable = true;
      } catch (error) { warnings.push({ code: "parent-source-unavailable", id: project.id }); }
    }
    if (declared && declared !== project.revision) errors.push({ code: "gitlink-pin-drift", id: project.id, expected: project.revision, declared });
    if (!declared && !project.parent) errors.push({ code: "missing-gitlink", id: project.id });
    if (metadataAvailable && !declaredOrigin) errors.push({ code: "missing-submodule-metadata", id: project.id });
    if (metadataAvailable && project.parent && !declared) errors.push({ code: "missing-nested-gitlink", id: project.id });
    if (declaredOrigin && normalizedOrigin(declaredOrigin) !== normalizedOrigin(project.repository)) errors.push({ code: "declared-origin-drift", id: project.id });
    if (!fs.existsSync(path.join(directory, ".git"))) { warnings.push({ code: "checkout-uninitialized", id: project.id }); checked.push({ id: project.id, status: "uninitialized", revision: project.revision }); continue; }
    try {
      const head = (await git(directory, ["rev-parse", "HEAD"])).trim();
      if (head !== project.revision) errors.push({ code: "checkout-pin-drift", id: project.id, expected: project.revision, actual: head });
      const origin = (await git(directory, ["config", "--get", "remote.origin.url"])).trim();
      if (normalizedOrigin(origin) !== normalizedOrigin(project.checkoutOrigin || project.repository)) errors.push({ code: "checkout-origin-drift", id: project.id });
      const dirty = (await git(directory, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"])).trim();
      if (dirty) errors.push({ code: "tracked-source-modified", id: project.id });
      const nested = await submodules(directory, project.revision);
      for (const child of nested) if (!sourcePaths.has(project.path + "/" + child.path)) errors.push({ code: "untracked-nested-upstream", path: project.path + "/" + child.path });
      for (const license of project.licensePaths || []) {
        if (!fs.existsSync(path.join(directory, relativePath(license)))) errors.push({ code: "license-evidence-missing", id: project.id, path: license });
      }
      if (project.licenseStatus === "unresolved") warnings.push({ code: "license-review-required", id: project.id });
      checked.push({ id: project.id, status: head === project.revision && !dirty ? "pinned" : "drift", revision: project.revision });
    } catch (error) { errors.push({ code: "source-inspection-failed", id: project.id, message: error.message.split("\n")[0] }); }
  }
  for (const project of inventory.projects) for (const ref of project.pinRefs || []) {
    try { if (sourceRef(root, ref) !== project.revision) errors.push({ code: "module-pin-drift", id: project.id, path: ref.path }); }
    catch (error) { errors.push({ code: "pin-evidence-invalid", id: project.id, message: error.message }); }
  }
  const declaredFiles = new Set();
  for (const recipe of inventory.recipes) {
    for (const ref of recipe.versionRefs || []) {
      try { if (sourceRef(root, ref) !== recipe.version) errors.push({ code: "adaptation-version-drift", recipe: recipe.id, path: ref.path }); }
      catch (error) { errors.push({ code: "version-evidence-invalid", recipe: recipe.id, message: error.message }); }
    }
    for (const ref of recipe.pinRefs || []) {
      try { if (sourceRef(root, ref) !== (recipe.revision || projects.get(recipe.project).revision)) errors.push({ code: "recipe-pin-drift", recipe: recipe.id, path: ref.path }); }
      catch (error) { errors.push({ code: "pin-evidence-invalid", recipe: recipe.id, message: error.message }); }
    }
    for (const file of recipe.ownedFiles || []) {
      declaredFiles.add(file.path);
      try { if (hash(fs.readFileSync(path.join(root, file.path))) !== file.sha256) errors.push({ code: "owned-adaptation-drift", recipe: recipe.id, path: file.path }); }
      catch { errors.push({ code: "owned-adaptation-missing", recipe: recipe.id, path: file.path }); }
    }
    for (const file of [...recipe.tests || [], ...recipe.buildEntries || []]) if (!fs.existsSync(path.join(root, file))) errors.push({ code: "recipe-entry-missing", recipe: recipe.id, path: file });
    for (const file of recipe.sourceEvidence || []) if (!fs.existsSync(path.join(root, relativePath(file)))) errors.push({ code: "source-evidence-missing", recipe: recipe.id, path: file });
    for (const guard of recipe.guards || []) {
      const project = projects.get(guard.sourceProject || recipe.project);
      if (!project?.path || !fs.existsSync(path.join(root, project.path, ".git"))) continue;
      for (const [file, expected] of Object.entries(guard.files)) {
        try {
          const revision = guard.sourceRevision || (project.id === recipe.project ? recipe.revision : null) || project.revision;
          const actual = hash(await sourceGuardBlob({ root, project, revision, file, projects }));
          if (actual !== expected) errors.push({ code: "original-source-evidence-drift", recipe: recipe.id, path: file });
        } catch { errors.push({ code: "original-source-evidence-unavailable", recipe: recipe.id, path: file }); }
      }
    }
    for (const operation of recipe.operations || []) if (operation.kind === "call") {
      try { let value = require(path.join(root, operation.module)); for (const key of operation.export.split(".")) value = value?.[key]; if (typeof value !== "function") throw Error("missing function"); }
      catch { errors.push({ code: "apply-entry-missing", recipe: recipe.id, path: operation.module, export: operation.export }); }
    }
  }
  for (const input of inventory.archiveInputs || []) {
    for (const file of input.evidence || []) if (!fs.existsSync(path.join(root, relativePath(file)))) errors.push({ code: "archive-evidence-missing", id: input.id, path: file });
    if (!/^[a-f0-9]{64}$/.test(input.sha256 || "")) errors.push({ code: "archive-pin-invalid", id: input.id });
    for (const ref of input.pinRefs || []) {
      try { if (sourceRef(root, ref) !== input.sha256) errors.push({ code: "archive-pin-drift", id: input.id, path: ref.path }); }
      catch (error) { errors.push({ code: "archive-evidence-invalid", id: input.id, message: error.message }); }
    }
  }
  for (const file of ownedAdaptationFiles(root, sourcePaths)) if (!declaredFiles.has(file)) errors.push({ code: "untracked-owned-adaptation", path: file });
  return { schemaVersion: 1, mode: "offline", passed: errors.length === 0, projects: checked.length,
    topLevelSubmodules: top.length, recipes: inventory.recipes.length, errors, warnings, checked };
}

function ensureOwnedWork(root, inventory, requested) {
  if (!path.isAbsolute(requested || "")) throw Error("Candidate work directory must be absolute.");
  let parent = path.resolve(requested), suffix = [];
  while (!fs.existsSync(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const resolved = path.join(fs.realpathSync(parent), ...suffix);
  const repositoryGit = path.join(fs.realpathSync(root), ".git");
  if (resolved === repositoryGit || resolved.startsWith(repositoryGit + path.sep)) throw Error("Candidate storage cannot be inside repository Git metadata.");
  for (const project of inventory.projects.filter(project => project.path)) {
    const source = path.resolve(root, project.path);
    const actual = fs.existsSync(source) ? fs.realpathSync(source) : source;
    if (resolved === actual || resolved.startsWith(actual + path.sep) || actual.startsWith(resolved + path.sep)) throw Error("Candidate storage must be separate from every upstream checkout.");
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length) throw Error("Choose a new empty owned candidate directory.");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}
async function materializeGitTree({ source, revision, destination, projects, project, root, includePaths = [], sourceScopes = {}, recordSource, budget = { files: 0, bytes: 0 } }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("A candidate must use its full immutable Git commit.");
  if (recordSource) await recordSource(source);
  const nestedProject = file => projects.find(item => project?.path && item.path === project.path + "/" + file ||
    item.parent === project?.id && item.sourceSubdirectory === file);
  const nestedPins = await treeLinks(source, revision);
  for (const child of await submodules(source, revision)) {
    const nested = nestedProject(child.path);
    if (!nested) throw Error(`Candidate introduces an uninventoried nested Git source: ${child.path}. Review its pin, license and build use first.`);
    if (normalizedOrigin(nested.repository) !== normalizedOrigin(child.repository)) throw Error(`Candidate nested origin changed: ${child.path}.`);
    if (nestedPins.get(child.path) !== nested.revision) throw Error(`Candidate nested source pin changed: ${child.path}. Review the new dependency before updating its inventory pin.`);
  }
  if (!includePaths.length && project?.id && sourceScopes[project.id]) includePaths = sourceScopes[project.id];
  const listingPaths = [...new Set([...includePaths, ...[...nestedPins.keys()].filter(nested => includePaths.some(file => file.startsWith(nested + "/")))])];
  const entries = (await git(source, ["ls-tree", "-rz", "-l", revision, ...(listingPaths.length ? ["--", ...listingPaths.map(relativePath)] : [])])).split("\0").filter(Boolean).map(row => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\s+(-|\d+)\t(.+)$/.exec(row);
    if (!match) throw Error("Unsupported candidate Git tree entry.");
    return { mode: match[1], kind: match[2], object: match[3], bytes: Number(match[4]) || 0, path: relativePath(match[5]) };
  });
  if (includePaths.length && !entries.length) throw Error("Declared candidate source scope is unavailable at this commit.");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const links = new Set(entries.filter(entry => entry.mode === "120000").map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split("/"); parts.pop();
    while (parts.length) { if (links.has(parts.join("/"))) throw Error("Candidate Git tree writes through a source symlink."); parts.pop(); }
    if (entry.kind === "commit") continue;
    budget.files++; budget.bytes += entry.bytes;
    if (budget.files > LIMITS.files || budget.bytes > LIMITS.bytes) throw Error("Candidate source exceeds bounded staging limits.");
    if (!["100644", "100755", "120000"].includes(entry.mode)) throw Error("Unsupported candidate file mode.");
  }
  const files = entries.filter(entry => entry.kind === "blob");
  for (let index = 0; index < files.length;) {
    const batch = []; let bytes = 0;
    while (index < files.length && (batch.length === 0 || bytes + files[index].bytes < 16 * 1024 * 1024) && batch.length < 1024) {
      const entry = files[index++]; batch.push(entry); bytes += entry.bytes;
    }
    const payloads = await blobs(source, batch);
    for (let item = 0; item < batch.length; item++) {
      const entry = batch[item], bytes = payloads[item];
      const file = path.join(destination, entry.path); fs.mkdirSync(path.dirname(file), { recursive: true });
      if (entry.mode === "120000") {
        const link = bytes.toString("utf8"), target = path.resolve(path.dirname(file), link);
        if (path.isAbsolute(link) || /\0/.test(link) || !target.startsWith(destination + path.sep)) throw Error("Candidate source symlink escapes its owned copy.");
        fs.symlinkSync(link, file);
      } else fs.writeFileSync(file, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
  }
  for (const entry of entries) {
    if (entry.kind === "commit") {
      const nested = nestedProject(entry.path);
      const nestedSource = nested?.path ? path.join(root, nested.path) : path.join(source, entry.path);
      if (!nested || !fs.existsSync(path.join(nestedSource, ".git"))) throw Error(`Candidate nested source is unavailable: ${entry.path}. Supply a complete separate checkout; no implicit fetch is performed.`);
      if (nested.revision !== entry.object) throw Error(`Candidate nested source pin changed: ${entry.path}.`);
      const nestedPaths = includePaths.includes(entry.path) ? [] : includePaths.filter(file => file.startsWith(entry.path + "/")).map(file => file.slice(entry.path.length + 1));
      await materializeGitTree({ source: nestedSource, revision: entry.object, destination: path.join(destination, entry.path), projects, project: nested, root, budget, recordSource, sourceScopes, includePaths: nestedPaths });
      continue;
    }
  }
  return budget;
}
function snapshot(directory) {
  const files = {};
  function visit(relative = "") {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.isSymbolicLink()) files[file] = "symlink:" + fs.readlinkSync(path.join(directory, file));
      else if (entry.isFile()) files[file] = hash(fs.readFileSync(path.join(directory, file)));
      else throw Error("Candidate source contains a special file.");
    }
  }
  visit(); return files;
}
function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(file => before[file] !== after[file])
    .map(file => ({ path: file, originalSha256: before[file] || null, adaptedSha256: after[file] || null }));
}
async function fingerprint(directory) {
  const bare = (await git(directory, ["rev-parse", "--is-bare-repository"])).trim() === "true";
  let head = null; try { head = (await git(directory, ["rev-parse", "HEAD"])).trim(); } catch {}
  return { head, bare, ...(bare ? {} : { index: await git(directory, ["ls-files", "--stage"]),
    status: await git(directory, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"]) }) };
}
function substitute(value, context) {
  if (typeof value === "string" && value.startsWith("$")) {
    let result = context; for (const key of value.slice(1).split(".")) result = result?.[key];
    if (result === undefined) throw Error(`Missing candidate input: ${value}.`);
    return result;
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, context));
  if (value && typeof value === "object") {
    if (Array.isArray(value.$path)) return path.join(...value.$path.map(item => substitute(item, context)));
    if (value.$evidence) {
      const ref = value.$evidence, filename = path.join(context.repository, relativePath(ref.path));
      let result = ref.kind === "json" ? JSON.parse(fs.readFileSync(filename, "utf8")) : require(filename);
      for (const key of String(ref.property || "").split(".").filter(Boolean)) result = result?.[key];
      if (!result) throw Error("Declared overlay hash evidence is unavailable.");
      return result;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]));
  }
  return value;
}
async function checkCandidate({ root = ROOT, inventory = JSON.parse(fs.readFileSync(INVENTORY, "utf8")), projectId, revision, workDir, sourceDir, recipeId, fetch = false, dependencies = {} }) {
  validateInventory(inventory);
  const project = inventory.projects.find(item => item.id === projectId);
  if (!project || !/^[a-f0-9]{40}$/.test(revision || "")) throw Error("Choose an inventoried project and a full candidate commit.");
  const work = ensureOwnedWork(root, inventory, workDir);
  let source = sourceDir || project.path && path.join(root, project.path);
  if (fetch) {
    source = path.join(work, "candidate.git"); fs.mkdirSync(source);
    await git(source, ["init", "--bare"]);
    await git(source, ["fetch", "--depth=1", "--no-tags", normalizedOrigin(project.checkoutOrigin || project.repository), revision]);
  }
  if (!source || !fs.existsSync(source)) throw Error("Provide a local Git checkout or explicitly use --fetch into owned storage.");
  const actualSource = fs.realpathSync(source);
  if (!fetch && (work === actualSource || work.startsWith(actualSource + path.sep) || actualSource.startsWith(work + path.sep))) throw Error("Candidate storage must be separate from the provided Git checkout.");
  const actual = (await git(source, ["rev-parse", `${revision}^{commit}`])).trim();
  if (actual !== revision) throw Error("Candidate object differs from its exact requested commit.");
  const recipes = inventory.recipes.filter(recipe => recipe.project === project.id && (!recipeId || recipe.id === recipeId));
  if (recipeId && !recipes.length) throw Error("The selected project has no such owned adaptation recipe.");
  const sourceBefore = new Map();
  const recordSource = async directory => {
    const location = fs.realpathSync(directory);
    if (!location.startsWith(work + path.sep) && !sourceBefore.has(location)) sourceBefore.set(location, await fingerprint(location));
  };
  if (project.path && fs.existsSync(path.join(root, project.path, ".git"))) await recordSource(path.join(root, project.path));
  const results = [];
  for (const recipe of recipes.length ? recipes : [{ id: "reference", operations: [] }]) {
    for (const file of recipe.ownedFiles || []) if (hash(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw Error(`Owned adaptation changed: ${file.path}. Review its inventory hash before a candidate check.`);
    const layout = path.join(work, recipe.id, "source");
    const stage = recipe.sourceSubdirectory ? path.join(layout, recipe.sourceSubdirectory) : layout;
    const budget = { files: 0, bytes: 0 };
    await materializeGitTree({ source, revision, destination: stage, projects: inventory.projects, project, root, includePaths: recipe.includePaths || [], sourceScopes: recipe.sourceScopes || {}, recordSource, budget });
    const inputs = {};
    const context = { repository: root, stage, layout, work: path.join(work, recipe.id), candidateRevision: revision, reviewedRevision: recipe.revision || project.revision,
      version: recipe.version || revision, inputs, logPath: path.join(work, recipe.id, "apply.log") };
    let error = null, records = [], before = snapshot(layout), outputBefore = [];
    try {
      for (const input of recipe.inputs || []) {
        const dependency = inventory.projects.find(item => item.id === input.project);
        const checkout = dependencies[input.project] || dependency?.path && path.join(root, dependency.path);
        if (!dependency || !checkout) throw Error(`Provide --dependency ${input.project}=<local Git checkout>.`);
        const destination = input.destination ? path.join(layout, input.destination) : path.join(work, recipe.id, "inputs", input.name);
        await materializeGitTree({ source: checkout, revision: input.revision || dependency.revision, destination, projects: inventory.projects, project: dependency, root, recordSource, budget, sourceScopes: recipe.sourceScopes || {} });
        inputs[input.name] = destination;
      }
      before = snapshot(layout);
      outputBefore = (recipe.outputRoots || []).map(output => ({ ...output, files: snapshot(substitute(output.originalRoot, context)) }));
      for (const [file, expected] of Object.entries(recipe.reviewedOriginalFiles || {})) {
        if ((before[file] || null) !== expected) throw Error(`Original source checksum differs: ${file}. Rebase the source overlay for the selected revision.`);
      }
      for (const output of outputBefore) for (const [file, expected] of Object.entries(output.reviewedOriginalFiles || {})) {
        if ((output.files[file] || null) !== expected) throw Error(`Original dependency checksum differs: ${output.name}/${file}.`);
      }
      for (const guard of recipe.guards || []) {
        const directory = substitute(guard.root || "$stage", context);
        for (const [file, expected] of Object.entries(guard.files)) {
          const location = path.join(directory, file);
          if (!fs.lstatSync(location).isFile() || hash(fs.readFileSync(location)) !== expected) throw Error(`Original source checksum differs: ${file}. Rebase the source overlay for the selected revision.`);
        }
      }
      for (const operation of recipe.operations || []) {
        if (operation.kind === "copy") {
          const target = path.join(stage, operation.to); fs.mkdirSync(path.dirname(target), { recursive: true });
          if (operation.expectAbsent && fs.existsSync(target)) throw Error(`Owned build file already exists in candidate: ${operation.to}. Review the new upstream file before replacing it.`);
          const input = typeof operation.from === "string" ? path.join(root, operation.from) : substitute(operation.from, context);
          if (typeof operation.from !== "string" && !input.startsWith(work + path.sep)) throw Error("A staged source copy must read from owned candidate inputs.");
          fs.copyFileSync(input, target);
        } else {
          let callback = require(path.join(root, operation.module)); for (const key of operation.export.split(".")) callback = callback?.[key];
          records.push(await callback(...substitute(operation.arguments || [], context)));
        }
      }
    } catch (caught) { error = caught.message; }
    const after = snapshot(layout), changed = changes(before, after);
    const outputCopies = outputBefore.map(output => {
      const directory = substitute(output.root, context);
      return { name: output.name, created: fs.existsSync(directory), changedFiles: fs.existsSync(directory) ? changes(output.files, snapshot(directory)) : [] };
    });
    if (!error) {
      for (const [file, expected] of Object.entries(recipe.reviewedAdaptedFiles || {})) {
        if ((after[file] || null) !== expected) { error = `Adapted source checksum differs: ${file}.`; break; }
      }
      if (!error && recipe.reviewedOriginalFiles) {
        const unexpected = changed.find(file => !Object.hasOwn(recipe.reviewedOriginalFiles, file.path));
        if (unexpected) error = `Apply routine changed a file outside its declared source inventory: ${unexpected.path}.`;
      }
      for (const output of outputBefore) {
        const directory = substitute(output.root, context);
        const adapted = fs.existsSync(directory) ? snapshot(directory) : {};
        for (const [file, expected] of Object.entries(output.reviewedAdaptedFiles || {})) {
          if ((adapted[file] || null) !== expected && !error) error = `Reviewed adapted dependency hash differs: ${output.name}/${file}.`;
        }
      }
    }
    results.push({ recipe: recipe.id, overlayApplyChecked: !!recipe.operations?.length,
      compatibleWithCurrentApplyRoutine: recipe.operations?.length ? !error : null, error, changedFiles: changed, records,
      sourceScope: recipe.sourceScopes || recipe.includePaths || "complete tracked Git tree", outputCopies,
      tests: recipe.tests || [], buildEntries: recipe.buildEntries || [] });
  }
  let upstreamCheckoutUnchanged = true;
  for (const [directory, before] of sourceBefore) if (JSON.stringify(before) !== JSON.stringify(await fingerprint(directory))) upstreamCheckoutUnchanged = false;
  const report = { schemaVersion: 1, mode: "candidate", project: project.id, reviewedRevision: project.revision, candidateRevision: revision,
    fetched: fetch, upstreamCheckoutUnchanged, sourceCheckoutsChecked: sourceBefore.size,
    passed: results.every(result => !result.error) && upstreamCheckoutUnchanged, readyForDistribution: false, results,
    requiredReview: ["source and license changes", "module/catalog/Git pins and adaptation identities", "focused tests and complete native rebuild", "new versioned package signatures/provenance", "actual original-game GUI/input/Stop qualification"] };
  fs.writeFileSync(path.join(work, "candidate-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return report;
}
function options(args) {
  const result = { dependencies: {} };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (["--json", "--fetch", "--help"].includes(option)) result[option.slice(2)] = true;
    else if (option === "--dependency") {
      const value = args[++index], separator = value?.indexOf("=");
      if (!(separator > 0)) throw Error("Use --dependency project-id=/absolute/local/checkout.");
      result.dependencies[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (["--project", "--candidate", "--work-dir", "--source", "--recipe"].includes(option)) {
      if (!args[index + 1]) throw Error(`Missing ${option} value.`);
      result[{ "--project": "projectId", "--candidate": "revision", "--work-dir": "workDir", "--source": "sourceDir", "--recipe": "recipeId" }[option]] = args[++index];
    } else throw Error("Usage: node scripts/check-upstream-overlays.cjs [--json] [--project ID --candidate FULL_SHA --work-dir /owned/path [--source /local/checkout] [--recipe ID] [--dependency ID=/local/checkout] [--fetch]]");
  }
  if (result.fetch && !result.revision) throw Error("--fetch requires an explicit candidate revision.");
  if (!result.revision && (result.projectId || result.recipeId || result.workDir || result.sourceDir || Object.keys(result.dependencies).length)) throw Error("Candidate source options require --candidate FULL_SHA.");
  return result;
}
if (require.main === module) {
  let parsed;
  Promise.resolve().then(() => {
    parsed = options(process.argv.slice(2));
    if (parsed.help) { process.stdout.write("Usage: node scripts/check-upstream-overlays.cjs [--json]\n       node scripts/check-upstream-overlays.cjs --project ID --candidate FULL_SHA --work-dir /owned/path [--source /local/checkout] [--recipe ID] [--dependency ID=/local/checkout] [--fetch] [--json]\nOffline by default. --fetch is the only network operation. Existing source checkouts and pins remain untouched.\n"); return null; }
    return parsed.revision ? checkCandidate(parsed) : checkInventory();
  }).then(report => {
    if (!report) return;
    if (parsed.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      const applied = report.results?.some(result => result.overlayApplyChecked);
      process.stdout.write(report.mode === "offline" ? `${report.projects} source projects, ${report.recipes} adaptation recipes: ${report.passed ? "checked" : "review required"}\n` : `${report.project} ${report.candidateRevision}: ${report.passed ? applied ? "current overlay applies; review/rebuild required" : "source snapshot checked; review/build required" : "overlay conflict"}\n`);
      for (const issue of report.errors || []) process.stdout.write(`${issue.code}: ${issue.id || issue.recipe || issue.path}\n`);
      for (const issue of report.warnings || []) process.stdout.write(`${issue.code}: ${issue.id}\n`);
      for (const result of report.results || []) if (result.error) process.stdout.write(`${result.recipe}: ${result.error}\n`);
    }
    process.exitCode = report.passed ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { ROOT, LIMITS, relativePath, normalizedOrigin, configRows, submodules, indexLinks, treeLinks,
  sourceRef, validateInventory, ownedAdaptationFiles, sourceGuardBlob, checkInventory, ensureOwnedWork, materializeGitTree, snapshot, substitute, checkCandidate, options };

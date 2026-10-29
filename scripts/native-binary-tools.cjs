// Shared native binary inspection, copying and dependency notices.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const B = require("../src/modules/shared/runtime/bundled-native");
const Native = require("../src/modules/shared/runtime/local-native");
const REPO = path.resolve(__dirname, "..");
const systemLink = value => value.startsWith("/usr/lib/") || value.startsWith("/System/Library/");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });

function macho(file) {
  try { return Native.readMachOArchitectures(file, { allowLibrary: true }); } catch { return null; }
}

function loadCommands(file, architecture) {
  const text = run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-l", file]);
  const minima = [...text.matchAll(/cmd LC_BUILD_VERSION[^]*?minos\s+(\d+\.\d+(?:\.\d+)?)/g),
    ...text.matchAll(/cmd LC_VERSION_MIN_MACOSX[^]*?version\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  if (!minima.length) throw new Error(`Missing macOS deployment target: ${file}`);
  const rpaths = [...text.matchAll(/cmd LC_RPATH\n[^]*?\n\s*path ([^\n]+) \(offset \d+\)/g)].map(match => match[1]);
  return { minimumMacOS: minima.sort((a, b) => B.versionAtLeast(a, b) ? -1 : 1)[0], rpaths };
}

function parseLinkedLibraries(output) {
  // Universal binaries have a separate unindented filename/architecture header
  // for each slice. Only indented compatibility records are dependency names.
  return [...new Set(String(output).split("\n").flatMap(line => {
    const match = /^\s+(.+?) \(compatibility version[^]*$/.exec(line);
    return match ? [match[1]] : [];
  }))];
}

function links(file, architecture) {
  return parseLinkedLibraries(run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-L", file]));
}

function libraryIds(file, architecture) {
  return run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-D", file]).split("\n").map(line => line.trim()).filter(line => line && !line.endsWith(":"));
}

function thinStagedMachO(target, payloadRoot, architecture, tool = run) {
  if (!["arm64", "x86_64"].includes(architecture)) throw new Error("Native thinning requires an explicit target CPU.");
  const root = fs.realpathSync(payloadRoot), file = path.resolve(target), relative = B.relativeFile(path.relative(root, file).split(path.sep).join("/"));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error("Native thinning requires a contained regular staging copy.");
  const architectures = macho(file);
  if (!architectures?.includes(architecture)) throw new Error("Native staging input has no selected CPU slice.");
  if (architectures.length === 1) return null;
  const beforeSha256 = Native.hashFile(file), temporary = path.join(path.dirname(file), `.thin-${crypto.randomUUID()}`);
  try {
    tool("/usr/bin/lipo", [file, "-thin", architecture, "-output", temporary]);
    if (!fs.lstatSync(temporary).isFile() || !isDeepStrictEqual(macho(temporary), [architecture]) || Native.hashFile(file) !== beforeSha256) throw new Error("Native slice extraction changed its input or produced a different CPU.");
    fs.chmodSync(temporary, stat.mode & 0o777);
    const afterSha256 = Native.hashFile(temporary), afterBytes = fs.statSync(temporary).size;
    fs.renameSync(temporary, file);
    return { file: relative, architecturesBefore: architectures, architecture, beforeSha256, beforeBytes: stat.size, afterSha256, afterBytes };
  } finally { fs.rmSync(temporary, { force: true }); }
}

function resolveLink(link, source, executable, inherited = [], architecture) {
  if (systemLink(link)) return null;
  const expand = value => value.replace(/^@loader_path(?=\/|$)/, path.dirname(source)).replace(/^@executable_path(?=\/|$)/, path.dirname(executable));
  const candidates = link.startsWith("@rpath/")
    ? [...loadCommands(source, architecture).rpaths, ...inherited].map(rpath => path.join(expand(rpath), link.slice(7)))
    : [expand(link)];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  throw new Error(`Unresolved non-system dependency '${link}' from ${source}. Add a complete framework/payload or fix its source build.`);
}

function copyTree(source, target, { excludes = [], rootExcludes = [], originalRoot = source, active = new Set() } = {}) {
  let resolved;
  try { resolved = fs.realpathSync(source); }
  catch (error) {
    // CMake app builds may retain an unused dylib alias for a renamed library.
    // Required load-command paths are checked separately and still fail closed.
    if (error.code === "ENOENT" && source.endsWith(".dylib") && fs.lstatSync(source).isSymbolicLink()) return;
    throw error;
  }
  const stat = fs.statSync(resolved);
  if (active.has(resolved)) throw new Error("Cyclic runtime payload symlink.");
  if (stat.isDirectory()) {
    if (resolved !== fs.realpathSync(originalRoot) && !resolved.startsWith(fs.realpathSync(originalRoot) + path.sep)) throw new Error("Runtime payload directory symlink escaped its root.");
    fs.mkdirSync(target, { recursive: true });
    const next = new Set([...active, resolved]);
    for (const name of fs.readdirSync(resolved)) {
      if ([".git", ".DS_Store", "__pycache__"].includes(name) || excludes.includes(name) ||
          resolved === fs.realpathSync(originalRoot) && rootExcludes.includes(name)) continue;
      copyTree(path.join(resolved, name), path.join(target, name), { excludes, rootExcludes, originalRoot, active: next });
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(resolved, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777);
  } else throw new Error("Runtime payload contains a non-file entry.");
}

function formulaRoot(file) {
  const match = fs.realpathSync(file).match(/^(.*\/Cellar\/([^/]+)\/([^/]+))\//);
  return match ? { root: match[1], name: match[2], version: match[3] } : null;
}

function assertPublicMetadata(value) {
  if (typeof value === "string") {
    if (/\/(?:Users|home|Volumes|tmp|var\/folders|private\/(?:tmp|var))\/|(?:^|[\s"'=\\/])\.local[\\/]|[A-Za-z]:[\\/]Users[\\/]/.test(value) || value.includes(REPO + path.sep)) {
      throw new Error("Runtime metadata contains a private filesystem location. Provide logical source identities and build path mappings.");
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertPublicMetadata(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { assertPublicMetadata(key); assertPublicMetadata(item); }
  }
  return value;
}

function publicProvenance(provenance, pathMappings = []) {
  if (!Array.isArray(pathMappings) || pathMappings.some(mapping => !mapping || !path.isAbsolute(mapping.from || "") ||
    typeof mapping.to !== "string" || !/^[A-Za-z0-9_${}.-]+$/.test(mapping.to))) throw new Error("Public provenance path mappings require absolute build prefixes and logical identities.");
  const mappings = [...pathMappings].sort((a, b) => b.from.length - a.from.length);
  function project(value) {
    if (typeof value === "string") return mappings.reduce((text, mapping) => text.split(mapping.from).join(mapping.to), value);
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === "object") {
      const entries = [], keys = new Set();
      for (const [key, item] of Object.entries(value)) {
        if (["logPath", "evidenceSource"].includes(key)) continue;
        const projectedKey = project(key);
        if (keys.has(projectedKey)) throw new Error("Public provenance projection produces a duplicate metadata key.");
        keys.add(projectedKey); entries.push([projectedKey, project(item)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  }
  return assertPublicMetadata(project(provenance));
}

function sanitizeHomebrewReceipt(receipt, formula) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || !/^[A-Za-z0-9][A-Za-z0-9@+_.-]*$/.test(formula?.name || "") ||
    !/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/.test(formula?.version || "")) throw new Error("A Homebrew receipt requires a public formula identity.");
  const sanitized = JSON.parse(JSON.stringify(receipt));
  if (!sanitized.source || typeof sanitized.source !== "object" || Array.isArray(sanitized.source)) throw new Error("Homebrew receipt source identity is missing.");
  delete sanitized.source.path;
  const tap = sanitized.source.tap || "homebrew/core";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(tap)) throw new Error("Homebrew receipt tap identity is invalid.");
  sanitized.source.formula = `${tap}/${formula.name}`;
  sanitized.source.pkg_version = formula.version;
  return assertPublicMetadata(sanitized);
}

function addDependencyNotices(source, payload, notices, seen, receiptRoot) {
  const formula = formulaRoot(source);
  if (!formula || seen.has(formula.root)) return;
  if (notices.some(notice => notice.dependencyName === formula.name)) { seen.add(formula.root); return; }
  const candidates = fs.readdirSync(formula.root).filter(name => /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i.test(name));
  if (!candidates.length) throw new Error(`Missing license notice for ${formula.name} ${formula.version}; add it explicitly to this package's notices.`);
  seen.add(formula.root);
  for (const name of candidates) {
    const relative = `licenses/dependencies/${formula.name}-${formula.version}/${name}`;
    copyTree(path.join(formula.root, name), path.join(payload, relative));
    notices.push({ name: `${formula.name} ${formula.version}`, license: "See included upstream license", sourceUrl: `https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/${formula.name[0]}/${formula.name}.rb`, path: relative });
  }
  const receipt = path.join(formula.root, "INSTALL_RECEIPT.json");
  if (fs.existsSync(receipt)) {
    const bytes = fs.readFileSync(receipt), directory = `${formula.name}-${formula.version}`;
    const privateDirectory = path.join(receiptRoot, "dependencies", B.relativeFile(directory));
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(privateDirectory, "INSTALL_RECEIPT.json"), bytes, { flag: "wx", mode: 0o600 });
    const sanitized = sanitizeHomebrewReceipt(JSON.parse(bytes), formula);
    fs.writeFileSync(path.join(payload, `licenses/dependencies/${directory}/INSTALL_RECEIPT.json`), JSON.stringify(sanitized, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  }
}
module.exports = { macho, loadCommands, parseLinkedLibraries, links, libraryIds, thinStagedMachO, resolveLink, copyTree, formulaRoot, assertPublicMetadata, publicProvenance, sanitizeHomebrewReceipt, addDependencyNotices };

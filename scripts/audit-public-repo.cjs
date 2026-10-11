#!/usr/bin/env node
// Read-only release audit. Findings contain categories and locations, never values.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const SOURCE_DIRS = new Set(["src", "scripts", "tests", "docs", "build", "resources"]);
const EXCLUDED_DIRS = new Set([".git", ".local", "node_modules", "dist", ".playwright-mcp"]);
const RECEIPT_PARTS = [".local", "notes", "public-audit-latest.json"];
const HISTORY_RECEIPT_PARTS = [".local", "notes", "public-history-audit-latest.json"];
const USAGE = "Usage: node scripts/audit-public-repo.cjs [--root repository] [--packaged-root resources] [--package-only | --history-only] [--history] [--json] [--no-receipt]\n" +
  "Default: public worktree/index and builder-selected app/resources. --history adds reachable local-ref blobs and commit metadata; --history-only inspects those alone. Automatic npm collection and submodule interiors are excluded.\n" +
  `Private receipts: ${RECEIPT_PARTS.join("/")} (default), ${HISTORY_RECEIPT_PARTS.join("/")} (history). Exit codes: 0 clear, 1 review, 2 audit/receipt failure.\n`;
const RULES = [
  ["personal_home_path", /(?:file:\/\/)?\/(?:Users|home)\/[^\s/"'<>`\\\0]{1,100}(?:\/[^\s"'<>`\0]{0,900})?/g],
  ["personal_volume_path", /(?:file:\/\/)?\/Volumes\/[^\s/"'<>`\\\0]{1,100}(?:\/[^\s"'<>`\0]{0,900})?/g],
  ["temporary_build_path", /(?:file:\/\/)?\/(?:private\/)?(?:var\/folders\/[^\s/"'<>`\\\0]{1,100}\/[^\s/"'<>`\\\0]{1,100}(?:\/[^\s"'<>`\0]{0,900})?|tmp\/maclauncher-[^\s"'<>`\\\0]{1,900})/g],
  ["private_maclauncher_build_path", /(?:file:\/\/)?\/(?:Users|home)\/([^\s/"'<>`\\\0]{1,100})\/(?:[^\s/"'<>`\\\0]{1,100}\/){0,8}maclauncher(?:-[^\s/"'<>`\\\0]{1,100})?\/\.local\/(?:example_repos|runtime-tests|runtime-builds|builds)\/[^\s"'<>`\0]{0,900}/gi,
    match => !/^(?:example(?:[-_]user)?|user(?:name)?|developer|builder|buildagent|ci|source|redacted(?:[-_]user)?)$/i.test(match[1])],
  ["private_key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ["credential_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|xox[baprs]-[A-Za-z0-9-]{16,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,255})\b/g],
  ["url_credentials", /\bhttps?:\/\/[^/@\s"'<>]{1,200}:[^/@\s"'<>]{1,200}@/g],
  ["assigned_credential", /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']([^"'\r\n]{8,512})["']/gi,
    match => !/(?:example|placeholder|redacted|dummy|test[_-]|your[_-]|\$\{|process\.env|^<)/i.test(match[1])],
  ["private_session_reference", /\.local\/(?:runtime-tests|test-data|notes)(?:\/[A-Za-z0-9._/-]+)?/g]
];

function git(root, args, { binary = false, maximum = 64 * 1024 * 1024, input } = {}) {
  // Missing objects in a partial clone must become incomplete scope, never an
  // implicit remote fetch or credential prompt during a local privacy audit.
  const offline = ["-c", "protocol.allow=never", ...["http", "https", "ssh", "git", "file", "ext", "ftp", "ftps"]
    .flatMap(protocol => ["-c", `protocol.${protocol}.allow=never`])];
  return execFileSync("git", [...offline, "-C", root, ...args], { encoding: binary ? undefined : "utf8", maxBuffer: maximum,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"], timeout: 30000 });
}
function nulList(text) { return text.split("\0").filter(Boolean); }
function label(value) {
  let safe = value.split(path.sep).join("/").replace(/[\u0000-\u001f\u007f]/g, "_");
  const parts = safe.split("/");
  const privateIndex = parts.findIndex(part => [".local", ".playwright-mcp", "game_tests", "example_games", "example_repos", "screenshots", "recordings"].includes(part));
  if (privateIndex >= 0) safe = parts.slice(0, privateIndex + 1).join("/") + "/[REDACTED]";
  for (const [category, regex] of RULES) {
    if (!["personal_home_path", "personal_volume_path", "temporary_build_path", "private_maclauncher_build_path", "credential_token", "url_credentials", "assigned_credential", "private_key"].includes(category)) continue;
    safe = safe.replace(new RegExp(regex.source, regex.flags), "[REDACTED]");
  }
  return safe.slice(0, 400);
}
function external(relative) { return relative === "src/external" || relative.startsWith("src/external/"); }
function privatePath(relative) { return relative.split("/").some(part => EXCLUDED_DIRS.has(part)); }
function privateWorkspacePath(relative) { return relative.split("/").some(part => [".git", ".local", ".playwright-mcp"].includes(part)); }
function intended(relative) { return !relative.includes("/") || SOURCE_DIRS.has(relative.split("/")[0]); }
function newlineCount(text) { return (text.match(/\n/g) || []).length; }
function binaryBytes(bytes) { return bytes.includes(0); }

function objectSizes(root, hashes) {
  if (!hashes.length) return new Map();
  const output = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: hashes.join("\n") + "\n", maximum: hashes.length * 512 + 4096 });
  const sizes = new Map();
  for (const row of output.trim().split("\n")) {
    const match = /^([a-f0-9]+) (blob|commit) (\d+)$/.exec(row);
    if (match) sizes.set(match[1], { type: match[2], size: Number(match[3]) });
  }
  return sizes;
}

function readObjectBatches(root, records, consume) {
  function read(batch) {
    const maximum = batch.reduce((sum, item) => sum + item.size + 512, 4096);
    const bytes = git(root, ["cat-file", "--batch"], { binary: true, maximum,
      input: batch.map(item => item.hash).join("\n") + "\n" });
    let offset = 0;
    for (const item of batch) {
      const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString("ascii");
      if (header !== `${item.hash} ${item.type} ${item.size}`) throw new Error("History object unavailable.");
      offset = end + 1;
      if (offset + item.size >= bytes.length || bytes[offset + item.size] !== 10) throw new Error("History object incomplete.");
      consume(item, bytes.subarray(offset, offset + item.size)); offset += item.size + 1;
    }
  }
  let batch = [], size = 0;
  for (const item of records) {
    if (batch.length && size + item.size > 16 * 1024 * 1024) { read(batch); batch = []; size = 0; }
    batch.push(item); size += item.size;
    if (size >= 16 * 1024 * 1024) { read(batch); batch = []; size = 0; }
  }
  if (batch.length) read(batch);
}
function builderSelectors(root, config) {
  // Use the packager's matcher, including its ordered filters, dotfile handling,
  // default app exclusions and directory pruning. A second glob implementation
  // could silently audit a different file set from the one being distributed.
  const { getFileMatchers, getMainFileMatchers } = require("app-builder-lib/out/fileMatcher");
  const build = config.build, mac = build.mac || {};
  const destination = path.join(root, ...RECEIPT_PARTS.slice(0, 2), "audit-package-destination");
  const output = path.resolve(root, build.directories?.output || "dist");
  const macroExpander = value => {
    if (value.includes("${")) throw new Error("Unresolved package macro.");
    return value;
  };
  const packager = { info: { projectDir: root, buildResourcesDir: build.directories?.buildResources || "build",
    config: build, isPrepackedAppAsar: false, debugLogger: { isEnabled: false } } };
  const selectors = (getMainFileMatchers(root, destination, macroExpander, mac, packager, output, false) || [])
    .map(matcher => ({ matcher, scope: "packaged-app" }));
  for (const name of ["extraResources", "extraFiles"]) {
    const matchers = getFileMatchers(build, name, destination, { macroExpander, customBuildOptions: mac,
      globalOutDir: output, defaultSrc: root }) || [];
    for (const matcher of matchers) {
      if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern("**/*");
      selectors.push({ matcher, scope: "packaged-resource" });
    }
  }
  return selectors;
}

function auditRepository({ root = process.cwd(), packagedRoots = [], maximumFileBytes = 256 * 1024 * 1024,
  maximumTotalBytes = 2 * 1024 * 1024 * 1024, maximumFiles = 50000, inspectPackages = true,
  inspectPublicSource = true, inspectHistory = false, maximumHistoryCommits = 1000,
  maximumHistoryBlobs = 50000 } = {}) {
  const requestedRoot = path.resolve(root);
  root = fs.realpathSync(root);
  const localPrefixes = new Set([requestedRoot, root]);
  const temporaryPrefixes = new Set();
  if (process.env.HOME && path.isAbsolute(process.env.HOME) && process.env.HOME !== path.parse(process.env.HOME).root)
    localPrefixes.add(path.resolve(process.env.HOME));
  if (requestedRoot.startsWith("/Volumes/")) localPrefixes.add(requestedRoot.split("/").slice(0, 3).join("/"));
  for (const value of [os.tmpdir(), process.env.TMPDIR]) {
    if (!value || !path.isAbsolute(value)) continue;
    const temporary = path.resolve(value);
    // Global /tmp paths also occur in portable upstream examples. A per-user
    // configured temporary root identifies this machine; retain symlink spellings.
    if (["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", path.parse(temporary).root].includes(temporary)) continue;
    localPrefixes.add(temporary);
    temporaryPrefixes.add(temporary);
    try { const real = fs.realpathSync(temporary); localPrefixes.add(real); temporaryPrefixes.add(real); } catch {}
  }
  const scanRules = RULES.map(([category, regex, accept]) => {
    if (category !== "temporary_build_path" || !temporaryPrefixes.size) return [category, regex, accept];
    const prefixes = [...temporaryPrefixes].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return [category, new RegExp(`(?:${regex.source}|(?:file:\\/\\/)?(?:${prefixes})(?=/|$)(?:/[^\\s\"'<>\u0060\\\\\\0]{0,900})?)`, "g"), accept];
  });
  const findings = new Map(), candidates = new Map();
  const stats = { indexEntries: 0, gitlinks: 0, publicFiles: 0, stagedBlobs: 0, packagedFiles: 0,
    packagedApplicationFiles: 0, packagedResourceFiles: 0, packagedExternalFiles: 0,
    scannedBytes: 0, textFiles: 0, binaryFiles: 0, skippedVendorFiles: 0, missingFiles: 0,
    packagedRootsPresent: 0, historyScanned: false, historyComplete: false, historyCommitCount: 0,
    historyCommitsScanned: 0, historyBlobCandidates: 0, historyBlobsScanned: 0, historyPathsScanned: 0,
    historyGitlinksSkipped: 0, historyExternalPathsSkipped: 0, historyBinaryBlobs: 0, historyTextBlobs: 0,
    historyBytes: 0, historyAuthorRecords: 0, historyCommitterRecords: 0, historyAuthorNameCount: 0,
    historyAuthorEmailCount: 0, historyCommitterNameCount: 0, historyCommitterEmailCount: 0,
    historyIdentityMetadataPresent: false, historyPotentialIdentityRecords: 0,
    historyCurrentGitIdentityRecords: 0, networkUsed: false };
  function add(category, file, line = null, scope = "worktree", count = 1, origin = null) {
    const safeFile = label(file), key = JSON.stringify([category, safeFile, line, scope, origin]);
    const previous = findings.get(key);
    if (previous) previous.count += count;
    else findings.set(key, { category, file: safeFile, line, scope, count, ...(origin ? { origin } : {}), redacted: true });
  }
  function pathChecks(relative, scope) {
    if (privateWorkspacePath(relative)) add("private_workspace_file", relative, null, scope);
    if (/(?:^|\/)(?:\.?localconfig(?:\.[^/]*)?|\.env(?:\.[^/]*)?|settings\.local\.json)$/i.test(relative)) add("local_configuration", relative, null, scope);
    if (/\.(?:log|har|pcap|heapsnapshot|trace)$/i.test(relative)) add("diagnostic_artifact", relative, null, scope);
    if (/(?:^|\/)(?:screenshots|recordings|game_tests|example_games|example_repos)(?:\/|$)/i.test(relative) ||
      /(?:^|\/)(?:session|desktop|screenshot|proof|game-inventory|playtest)[-_.][^/]*\.(?:png|jpe?g|json|md|txt|html)$/i.test(relative) ||
      /(?:^|\/)ENGINE_PROGRESS\.(?:json|md)$/i.test(relative)) add("private_session_artifact", relative, null, scope);
    if (/\.(?:npa|xp3|npk|rpa|rpgmvp|rpgmvo|rpgmvm)$/i.test(relative)) add("game_payload", relative, null, scope);
  }
  function scanText(text, file, scope, baseLine = 0, binary = false, acceptAfter = -1, scale = 1, byteOffset = 0) {
    for (const [category, regex, accept] of scanRules) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text))) {
        if ((match.index + match[0].length) * scale + byteOffset <= acceptAfter || accept && !accept(match)) continue;
        const line = binary ? null : baseLine + newlineCount(text.slice(0, match.index)) + 1;
        let origin = null;
        if (["personal_home_path", "personal_volume_path", "temporary_build_path"].includes(category)) {
          const absolute = match[0].replace(/^file:\/\//, "");
          origin = [...localPrefixes].some(prefix => absolute === prefix || absolute.startsWith(prefix + "/")) ?
            "current-machine" : "other-machine-or-example";
        }
        add(category, file, line, scope, 1, origin);
      }
    }
  }
  function scanBuffer(bytes, file, scope) {
    const binary = binaryBytes(bytes);
    scanText(bytes.toString("latin1"), file, scope, 0, binary);
    if (binary) {
      scanText(bytes.toString("utf16le"), file, scope, 0, true);
      scanText(bytes.subarray(1).toString("utf16le"), file, scope, 0, true);
    }
  }
  function addFile(absolute, file, scope) {
    const previous = candidates.get(absolute);
    if (previous) { previous.scopes.add(scope); return; }
    if (candidates.size >= maximumFiles) { add("scan_incomplete_file_limit", file, null, scope); return; }
    candidates.set(absolute, { file, scopes: new Set([scope]) });
  }

  let rows = [];
  try {
    if (inspectPublicSource) rows = nulList(git(root, ["ls-files", "--stage", "-z"]));
    else git(root, ["rev-parse", "--git-dir"]);
  } catch { throw new Error("The public audit requires an accessible Git repository."); }
  const index = new Map();
  for (const row of inspectPublicSource ? rows : []) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);
    if (!match) continue;
    stats.indexEntries++;
    const [, mode, hash, stage, relative] = match;
    if (mode === "160000") { stats.gitlinks++; continue; }
    if (external(relative)) { stats.skippedVendorFiles++; continue; }
    if (stage !== "0") add("unmerged_index", relative, null, "index");
    index.set(relative, { hash, mode }); pathChecks(relative, "index");
    if (!privatePath(relative)) addFile(path.join(root, relative), relative, "worktree");
  }
  for (const relative of inspectPublicSource ? nulList(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])) : []) {
    if (!intended(relative) || external(relative) || privatePath(relative)) continue;
    pathChecks(relative, "untracked"); addFile(path.join(root, relative), relative, "untracked");
  }

  // A cleaned working file does not erase a leak still present in the index.
  const changed = new Set(inspectPublicSource ? [
    ...nulList(git(root, ["diff", "--name-only", "-z"])),
    ...nulList(git(root, ["diff", "--cached", "--name-only", "-z"]))
  ] : []);
  for (const relative of changed) {
    if (external(relative) || privatePath(relative) || !index.has(relative)) continue;
    const entry = index.get(relative);
    let size;
    try { size = Number(git(root, ["cat-file", "-s", entry.hash]).trim()); }
    catch { add("index_blob_unavailable", relative, null, "index"); continue; }
    if (!Number.isSafeInteger(size) || size > Math.min(maximumFileBytes, 32 * 1024 * 1024) || stats.scannedBytes + size > maximumTotalBytes) {
      add("scan_incomplete_index_blob", relative, null, "index"); continue;
    }
    const bytes = git(root, ["cat-file", "blob", entry.hash], { binary: true, maximum: size + 1024 });
    scanBuffer(bytes, relative, "index"); stats.stagedBlobs++; stats.scannedBytes += bytes.length;
  }

  const packageRoots = [];
  if (inspectPackages) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
    catch { if (fs.existsSync(path.join(root, "package.json"))) add("package_configuration_invalid", "package.json"); }
    if (config?.build) {
      let selectors;
      try { selectors = builderSelectors(root, config); }
      catch { add("scan_incomplete_package_selectors", "package.json", null, "packaged"); }
      for (const { matcher, scope } of selectors || []) {
        const from = path.relative(root, matcher.from).split(path.sep).join("/");
        if (from.startsWith("../") || from === ".." || path.isAbsolute(from)) {
          add("package_root_outside_repository", "package.json", null, scope); continue;
        }
        packageRoots.push({ absolute: matcher.from, file: from, scope, filter: matcher.createFilter(),
          key: JSON.stringify([matcher.from, matcher.patterns, scope]) });
      }
    }
  }
  packagedRoots.forEach((value, i) => packageRoots.push({ absolute: path.resolve(root, value), file: `packaged[${i + 1}]`,
    scope: "packaged-explicit", filter: () => true, key: `explicit-${i}` }));
  const visitedPackage = new Set();
  function walk(absolute, file, depth = 0, selectedRoot) {
    const scope = selectedRoot.scope;
    if (depth > 32 || candidates.size >= maximumFiles) { add("scan_incomplete_package_tree", file, null, scope); return; }
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { add("package_file_unavailable", file, null, scope); return; }
    if (!selectedRoot.filter(absolute, stat)) return;
    if (stat.isSymbolicLink()) {
      let target;
      try {
        if (path.isAbsolute(fs.readlinkSync(absolute))) add("package_symlink_absolute_target", file, null, scope);
        target = fs.realpathSync(absolute);
      } catch { add("package_symlink_unavailable", file, null, scope); return; }
      // Declared portable runtimes may contain internal symlinks, never arbitrary
      // home links. Do not traverse a target outside the selected package root.
      if (target !== selectedRoot.absolute && !target.startsWith(selectedRoot.absolute + path.sep)) add("package_symlink_outside_root", file, null, scope);
      return;
    }
    if (stat.isDirectory()) {
      const visitKey = JSON.stringify([absolute, selectedRoot.key]);
      if (visitedPackage.has(visitKey)) return;
      visitedPackage.add(visitKey);
      let entries;
      try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
      catch { add("package_directory_unavailable", file, null, scope); return; }
      for (const entry of entries) {
        // Object databases are outside the audit, but selecting Git metadata
        // for distribution is itself a finding. Explicitly selected resource
        // dependency folders are inspected; automatic npm collection is separate.
        if (entry.name === ".git") {
          const metadata = path.join(absolute, entry.name);
          try {
            if (selectedRoot.filter(metadata, fs.lstatSync(metadata)))
              add("package_git_metadata_selected", file ? `${file}/.git` : ".git", null, scope);
          } catch { add("package_file_unavailable", file ? `${file}/.git` : ".git", null, scope); }
          continue;
        }
        walk(path.join(absolute, entry.name), file ? `${file}/${entry.name}` : entry.name, depth + 1, selectedRoot);
      }
    } else if (stat.isFile()) {
      stats.packagedFiles++;
      if (scope === "packaged-app") stats.packagedApplicationFiles++; else stats.packagedResourceFiles++;
      if (external(file)) stats.packagedExternalFiles++;
      pathChecks(file, scope); addFile(absolute, file, scope);
    }
  }
  for (const item of packageRoots) {
    if (!fs.existsSync(item.absolute)) { add("package_root_unavailable", item.file, null, item.scope); continue; }
    stats.packagedRootsPresent++; walk(item.absolute, item.file, 0, item);
  }

  for (const [absolute, candidate] of candidates) {
    const scope = [...candidate.scopes].sort().join("+");
    let stat;
    try { stat = fs.lstatSync(absolute); } catch {
      stats.missingFiles++;
      if (!changed.has(candidate.file)) add("public_file_unavailable", candidate.file, null, scope);
      continue;
    }
    if (stat.isSymbolicLink()) { add("public_symlink", candidate.file, null, scope); continue; }
    if (!stat.isFile()) continue;
    if (stat.size > maximumFileBytes || stats.scannedBytes + stat.size > maximumTotalBytes) { add("scan_incomplete_bytes", candidate.file, null, scope); continue; }
    const descriptor = fs.openSync(absolute, "r");
    let carry = Buffer.alloc(0), lines = 0, binary = false;
    try {
      const chunk = Buffer.alloc(256 * 1024);
      for (let offset = 0; offset < stat.size;) {
        const length = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (!length) { add("scan_incomplete_read", candidate.file, null, scope); break; }
        const bytes = chunk.subarray(0, length); binary ||= binaryBytes(bytes);
        const combined = Buffer.concat([carry, bytes]), text = combined.toString("latin1");
        scanText(text, candidate.file, scope, lines - newlineCount(carry.toString("latin1")), binary, carry.length);
        if (binary) {
          scanText(combined.toString("utf16le"), candidate.file, scope, 0, true, carry.length, 2);
          scanText(combined.subarray(1).toString("utf16le"), candidate.file, scope, 0, true, carry.length, 2, 1);
        }
        lines += newlineCount(bytes.toString("latin1")); offset += length;
        carry = Buffer.from(combined.subarray(Math.max(0, combined.length - 2048)));
      }
      stats.scannedBytes += stat.size; stats.publicFiles++;
      if (binary) stats.binaryFiles++; else stats.textFiles++;
    } finally { fs.closeSync(descriptor); }
  }

  if (inspectHistory) {
    stats.historyScanned = true;
    stats.historyCommitCount = Number(git(root, ["rev-list", "--all", "--count"]).trim());
    let commits = git(root, ["rev-list", `--max-count=${maximumHistoryCommits + 1}`, "--all"]).trim().split("\n").filter(Boolean);
    if (commits.length > maximumHistoryCommits) {
      add("scan_incomplete_history_commit_limit", "git-history", null, "history");
      commits = commits.slice(0, maximumHistoryCommits);
    }
    const historical = new Map(), pairs = new Set(), gitlinks = new Set(), externalPaths = new Set();
    let pathsLimited = false, blobsLimited = false;
    for (const [ordinal, commit] of commits.entries()) {
      let rows;
      try { rows = nulList(git(root, ["ls-tree", "-r", "-z", "--full-tree", commit])); }
      catch { add("scan_incomplete_history_tree", `git-history/commit[${ordinal + 1}]`, null, "history"); continue; }
      for (const row of rows) {
        const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (!match) continue;
        const [, mode, type, hash, relative] = match;
        if (mode === "160000") { gitlinks.add(JSON.stringify([hash, relative])); continue; }
        if (external(relative)) { externalPaths.add(JSON.stringify([hash, relative])); continue; }
        if (type !== "blob") continue;
        const pair = JSON.stringify([hash, relative]);
        if (pairs.has(pair)) continue;
        if (pairs.size >= maximumFiles) {
          if (!pathsLimited) add("scan_incomplete_history_path_limit", "git-history", null, "history");
          pathsLimited = true; continue;
        }
        if (!historical.has(hash) && historical.size >= maximumHistoryBlobs) {
          if (!blobsLimited) add("scan_incomplete_history_blob_limit", "git-history", null, "history");
          blobsLimited = true; continue;
        }
        pairs.add(pair);
        if (!historical.has(hash)) historical.set(hash, new Set());
        historical.get(hash).add(relative);
      }
    }
    stats.historyGitlinksSkipped = gitlinks.size; stats.historyExternalPathsSkipped = externalPaths.size;
    stats.historyBlobCandidates = historical.size;
    const sizes = objectSizes(root, [...commits, ...historical.keys()]), records = [];
    let reserved = 0;
    function select(hash, type, data) {
      const entry = sizes.get(hash), file = type === "commit" ? `git-history/commit[${data.ordinal + 1}]` : [...data.paths][0];
      if (!entry || entry.type !== type || !Number.isSafeInteger(entry.size)) {
        add("scan_incomplete_history_object", file, null, "history"); return;
      }
      const perFileLimit = type === "commit" ? Math.min(maximumFileBytes, 1024 * 1024) : maximumFileBytes;
      if (entry.size > perFileLimit || stats.scannedBytes + reserved + entry.size > maximumTotalBytes) {
        add("scan_incomplete_history_bytes", file, null, "history"); return;
      }
      reserved += entry.size; records.push({ hash, type, size: entry.size, ...data });
    }
    commits.forEach((hash, ordinal) => select(hash, "commit", { ordinal }));
    for (const [hash, paths] of historical) select(hash, "blob", { paths });
    const identities = { author: { names: new Set(), emails: new Set() }, committer: { names: new Set(), emails: new Set() } };
    function configured(field) { try { return git(root, ["config", "--get", `user.${field}`]).trim(); } catch { return ""; } }
    const configuredName = configured("name"), configuredEmail = configured("email");
    readObjectBatches(root, records, (item, bytes) => {
      stats.scannedBytes += bytes.length; stats.historyBytes += bytes.length;
      if (item.type === "commit") {
        stats.historyCommitsScanned++;
        const text = bytes.toString("utf8");
        for (const role of ["author", "committer"]) {
          const match = new RegExp(`^${role} (.*) <([^<>]*)> -?\\d+ [+-]\\d{4}$`, "m").exec(text);
          if (!match) continue;
          stats[role === "author" ? "historyAuthorRecords" : "historyCommitterRecords"]++;
          const [, name, email] = match;
          if (name) identities[role].names.add(name); if (email) identities[role].emails.add(email);
          if (name || email) stats.historyIdentityMetadataPresent = true;
          const placeholderName = /^(?:unknown|anonymous|anon|user|you|me|root|your name|(?:test|example|synthetic|fixture)(?:\b.*)?)$/i.test(name);
          const placeholderEmail = /@(?:(?:[^@]+\.)?example\.(?:com|net|org)|[^@]+\.(?:invalid|test)|localhost(?:\.localdomain)?)$/i.test(email);
          if (name && !placeholderName || email && !placeholderEmail) stats.historyPotentialIdentityRecords++;
          if (configuredName && name === configuredName || configuredEmail && email === configuredEmail)
            stats.historyCurrentGitIdentityRecords++;
        }
        scanBuffer(bytes, `git-history/commit[${item.ordinal + 1}]`, "history-metadata");
      } else {
        stats.historyBlobsScanned++;
        if (binaryBytes(bytes)) stats.historyBinaryBlobs++; else stats.historyTextBlobs++;
        for (const file of item.paths) {
          stats.historyPathsScanned++; pathChecks(file, "history-blob"); scanBuffer(bytes, file, "history-blob");
        }
      }
    });
    stats.historyAuthorNameCount = identities.author.names.size; stats.historyAuthorEmailCount = identities.author.emails.size;
    stats.historyCommitterNameCount = identities.committer.names.size; stats.historyCommitterEmailCount = identities.committer.emails.size;
    if (stats.historyPotentialIdentityRecords)
      add("history_identity_metadata", "git-history/author-and-committer-metadata", null, "history-metadata", stats.historyPotentialIdentityRecords);
    stats.historyComplete = ![...findings.values()].some(item => item.category.startsWith("scan_incomplete_history"));
  }
  const records = [...findings.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0) || a.category.localeCompare(b.category));
  const categories = {};
  for (const item of records) categories[item.category] = (categories[item.category] || 0) + item.count;
  return { schemaVersion: 2, readOnly: true, valuesRedacted: true, status: records.length ? "review" : "clear",
    scope: { publicSource: inspectPublicSource, differingIndexBlobs: inspectPublicSource,
      builderSelectedApplicationFiles: inspectPackages, builderSelectedResources: inspectPackages,
      explicitPackagedRoots: packagedRoots.length, externalSource: "gitlinks only; selected packaged assets inspected",
      gitHistory: inspectHistory ? "reachable local refs; root-repository blobs and commit metadata; submodule interiors excluded" : false,
      collectedNodeDependencies: false }, stats,
    categories, findings: records };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(USAGE); return 0; }
  let root = process.cwd(), json = false, receipt = true, inspectPublicSource = true, inspectPackages = true, inspectHistory = false;
  const packagedRoots = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") { if (!argv[++i]) throw new Error("Missing repository argument."); root = argv[i]; }
    else if (argv[i] === "--packaged-root") { if (!argv[++i]) throw new Error("Missing packaged-resource argument."); packagedRoots.push(argv[i]); }
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--no-receipt") receipt = false;
    else if (argv[i] === "--package-only") inspectPublicSource = false;
    else if (argv[i] === "--history") inspectHistory = true;
    else if (argv[i] === "--history-only") { inspectHistory = true; inspectPublicSource = false; inspectPackages = false; }
    else throw new Error(USAGE);
  }
  if (argv.includes("--package-only") && argv.includes("--history-only")) throw new Error(USAGE);
  const result = auditRepository({ root, packagedRoots, inspectPublicSource, inspectPackages, inspectHistory });
  const receiptParts = inspectHistory ? HISTORY_RECEIPT_PARTS : RECEIPT_PARTS;
  let receiptWritten = false;
  if (receipt) {
    const relativeReceipt = receiptParts.join("/");
    const destination = path.join(path.resolve(root), ...receiptParts);
    // Preserve local configuration and keep audit receipts outside public files.
    try {
      git(root, ["check-ignore", "--no-index", "-q", "--", relativeReceipt]);
      if (nulList(git(root, ["ls-files", "-z", "--", relativeReceipt])).length) throw new Error("Receipt is tracked.");
      for (const relative of [receiptParts[0], path.join(...receiptParts.slice(0, 2))]) {
        const directory = path.join(path.resolve(root), relative);
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("Receipt directory unavailable.");
        fs.mkdirSync(directory, { recursive: true });
      }
      const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Receipt is not a private regular file.");
        fs.fchmodSync(fd, 0o600); fs.ftruncateSync(fd, 0);
        fs.writeFileSync(fd, JSON.stringify(result, null, 2) + "\n");
      } finally { fs.closeSync(fd); }
      receiptWritten = true;
    } catch { process.stderr.write("Private audit receipt could not be written; no public receipt was created.\n"); }
  }
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write(`Public audit: ${result.status}; ${result.stats.publicFiles} files, ${result.stats.gitlinks} gitlinks, ${result.stats.binaryFiles} binary files. Values are redacted.\n`);
    for (const item of result.findings.slice(0, 100)) process.stdout.write(`${item.category} ${item.file}${item.line == null ? "" : `:${item.line}`} count=${item.count} scope=${item.scope}\n`);
    if (result.findings.length > 100) process.stdout.write(`Additional redacted finding groups: ${result.findings.length - 100}.\n`);
    if (inspectHistory) process.stdout.write(`History: ${result.stats.historyCommitsScanned}/${result.stats.historyCommitCount} commits, ${result.stats.historyBlobsScanned} unique blobs; complete=${result.stats.historyComplete}. Identity values are redacted.\n`);
    if (receiptWritten) process.stdout.write(`Full redacted receipt: ${receiptParts.join("/")}\n`);
  }
  return receipt && !receiptWritten ? 2 : result.findings.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { process.stderr.write("Public audit could not finish; no private values were printed.\n"); process.exitCode = 2; }
}
module.exports = { auditRepository, main };

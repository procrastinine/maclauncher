const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Core = require("../src/modules/rgss/runtime/mkxpz-runtime-manager");
const Binary = require("../src/modules/rgss/runtime/bundled-binary.json");

const REPO = path.resolve(__dirname, "..");
const OWNER_FILE = ".maclauncher-mkxpz-candidates.json";
const OWNER_FORMAT = "maclauncher-mkxpz-candidates-v1";
const RECEIPT_FORMAT = "maclauncher-mkxpz-candidate-v1";
const REPOSITORY = "mkxp-z/mkxp-z";
const DEFAULT_OUTPUT = path.join(os.homedir(), "Library", "Caches", "maclauncher", "mkxpz-candidates");
const contains = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
};

// Resolve missing suffixes and existing symlinks, including checkout aliases.
function canonicalPath(input) {
  let current = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Candidate path has an unresolved symlink.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Cannot resolve candidate output.");
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error("Candidate review records must be bounded regular files.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ignoredOutput(repository, candidate) {
  const relative = path.relative(repository, candidate);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return false;
  try {
    execFileSync("git", ["-C", repository, "check-ignore", "--no-index", "-q", "--", relative], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function resolveOutput(output, repositoryRoot = REPO) {
  const repository = path.resolve(repositoryRoot);
  const requested = output === undefined ? DEFAULT_OUTPUT : output;
  if (typeof requested !== "string" || !requested.trim() || /[\x00-\x1f]/.test(requested)) {
    throw new Error("Choose an explicit private candidate output directory.");
  }
  const absolute = path.resolve(requested), resolved = canonicalPath(absolute);
  for (const sourceRoot of new Set([repository, fs.realpathSync(repository)])) {
    for (const candidate of [absolute, resolved]) {
      if (contains(candidate, sourceRoot) || contains(sourceRoot, candidate) &&
          !ignoredOutput(sourceRoot, candidate)) {
        throw new Error("Candidate output must be ignored by Git or outside public repository source.");
      }
    }
  }
  // Public directories and external checkouts can also be symlinked outside
  // the repository. Their canonical targets remain source, never output.
  const sourceDirectories = fs.readdirSync(repository, { withFileTypes: true })
    .filter(entry => !ignoredOutput(repository, path.join(repository, entry.name)) && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => path.join(repository, entry.name));
  const external = path.join(repository, "src/external");
  if (fs.existsSync(external)) {
    sourceDirectories.push(...fs.readdirSync(external, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(external, entry.name)));
  }
  if (sourceDirectories.some(source => fs.existsSync(source) && contains(canonicalPath(source), resolved))) {
    throw new Error("Candidate output cannot be inside public or external source directories.");
  }
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) throw new Error("Candidate output must be a directory.");
    const owner = path.join(resolved, OWNER_FILE);
    if (fs.existsSync(owner)) {
      if (readJson(owner).format !== OWNER_FORMAT) throw new Error("Candidate output ownership record is invalid.");
    } else if (fs.readdirSync(resolved).length) {
      throw new Error("Choose an empty directory or an existing MKXP-Z candidate output.");
    }
  }
  return resolved;
}

function ownedPath(root, ...parts) {
  const file = path.join(root, ...parts);
  if (!contains(root, file) || canonicalPath(file) !== file) {
    throw new Error("Candidate files must stay inside owned output without symlink escapes.");
  }
  return file;
}

function writeJson(root, parts, payload) {
  const file = ownedPath(root, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return file;
}

function versionIdentity(version) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z_([a-f0-9]{40})$/.exec(version || "");
  if (!match) throw new Error("MKXP-Z candidate version needs an exact Actions date and 40-character source SHA.");
  const date = `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace(".000Z", "Z") !== date) {
    throw new Error("MKXP-Z candidate version has an invalid Actions date.");
  }
  return { date, sha: match[5] };
}

function validateEntry(entry, version) {
  const identity = versionIdentity(version);
  if (entry?.version !== version || entry.date !== identity.date || entry.sha !== identity.sha ||
      !Number.isSafeInteger(entry.runId) || entry.runId < 1 ||
      !Number.isSafeInteger(entry.artifactId) || entry.artifactId < 1 ||
      typeof entry.name !== "string" || !entry.name || entry.name.length > 200 || /[\x00-\x1f]/.test(entry.name)) {
    throw new Error("MKXP-Z catalog entry does not match its exact version, source SHA or Actions identity.");
  }
  return { version, date: identity.date, sha: identity.sha,
    runId: entry.runId, artifactId: entry.artifactId, name: entry.name };
}

function validateIncluded(binary, core) {
  const identity = versionIdentity(binary.version);
  if (binary.version !== core.BUNDLED_VERSION || binary.appName !== core.BUNDLED_APP_NAME ||
      !/^[A-Za-z0-9._ -]+\.app$/.test(binary.appName || "") ||
      binary.upstreamRevision !== identity.sha ||
      binary.sourceUrl !== `https://github.com/${REPOSITORY}/tree/${identity.sha}` ||
      !/^[a-f0-9]{64}$/.test(binary.executableSha256 || "") || !/^[a-f0-9]{64}$/.test(binary.treeSha256 || "")) {
    throw new Error("Included MKXP-Z catalog pin is inconsistent; candidate fetching cannot change it.");
  }
}

function inspectCandidate(root, entry, binary, install) {
  const installDir = ownedPath(root, "runtimes/mkxpz", entry.version);
  const appPath = ownedPath(root, "runtimes/mkxpz", entry.version, binary.appName);
  if (install && (install.version !== entry.version || install.installDir !== installDir || install.appPath !== appPath)) {
    throw new Error("Downloaded MKXP-Z descriptor does not match the selected candidate identity or owned app path.");
  }
  const meta = readJson(ownedPath(root, "runtimes/mkxpz", entry.version, ".maclauncher-mkxpz.json"));
  if (meta.version !== entry.version || meta.runId !== entry.runId || meta.artifactId !== entry.artifactId ||
      meta.sha !== entry.sha || meta.date !== entry.date || meta.artifactName !== entry.name || meta.source !== "GitHub Actions") {
    throw new Error("Downloaded MKXP-Z installation record does not match the selected Actions artifact.");
  }
  if (!fs.lstatSync(appPath).isDirectory()) throw new Error("Downloaded MKXP-Z app is missing.");
  const executable = ownedPath(root, "runtimes/mkxpz", entry.version, binary.appName,
    "Contents/MacOS", binary.appName.slice(0, -4));
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error("Candidate native executable is missing or not executable.");
  const executableSha256 = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
  const { reviewedBinaryTree } = require("./stage-native-runtimes.cjs");
  return { appRelativePath: path.relative(root, appPath).split(path.sep).join("/"),
    executableSha256, treeSha256: reviewedBinaryTree(appPath) };
}

function proposedPin(entry, binary, inspected) {
  return { schemaVersion: 1, version: entry.version, appName: binary.appName, upstreamRevision: entry.sha,
    sourceUrl: `https://github.com/${REPOSITORY}/tree/${entry.sha}`,
    binaryOrigin: `GitHub Actions candidate pending review; run ${entry.runId}, artifact ${entry.artifactId}`,
    executableSha256: inspected.executableSha256, treeSha256: inspected.treeSha256 };
}

function reuseCandidate(root, version, binary, entry) {
  const receiptPath = ownedPath(root, "reviews", `${version}.json`);
  if (!fs.existsSync(receiptPath)) return null;
  const receipt = readJson(receiptPath);
  const recorded = validateEntry(receipt.actions, version);
  if (receipt.format !== RECEIPT_FORMAT || receipt.status !== "pending-review" ||
      entry && JSON.stringify(recorded) !== JSON.stringify(entry)) {
    throw new Error("Existing candidate review identifies a different Actions artifact; preserve it for review.");
  }
  const inspected = inspectCandidate(root, recorded, binary);
  const proposal = proposedPin(recorded, binary, inspected);
  if (Object.entries(inspected).some(([key, value]) => value !== receipt[key]) ||
      Object.keys(receipt.proposedPin || {}).length !== Object.keys(proposal).length ||
      Object.entries(proposal).some(([key, value]) => receipt.proposedPin?.[key] !== value)) {
    throw new Error("Existing candidate bytes or review pin changed; preserve them for review.");
  }
  return { updated: false, downloaded: false, reused: true, version, candidate: receipt,
    receiptPath, appPath: path.join(root, receipt.appRelativePath) };
}

async function fetchMkxpzCandidate({ logger = console, outputRoot, version } = {},
    { core = Core, binary = Binary, repositoryRoot = REPO } = {}) {
  validateIncluded(binary, core);
  const requestedVersion = version === undefined ? null : core.normalizeVersion(version);
  if (requestedVersion) versionIdentity(requestedVersion);
  const root = resolveOutput(outputRoot, repositoryRoot);
  const noChange = selected => {
    logger?.info?.(`[mkxpz] Included version is already selected (${selected}); no candidate downloaded.`);
    return { updated: false, downloaded: false, reused: false, version: selected, reason: "already-included" };
  };
  if (requestedVersion === binary.version) return noChange(requestedVersion);
  if (requestedVersion) {
    const reused = reuseCandidate(root, requestedVersion, binary);
    if (reused) return reused;
  }
  if (!await core.canUseGh({ logger })) {
    throw new Error("Fetching new Actions candidates needs authenticated GitHub CLI. Install gh with Homebrew (/opt/homebrew/bin on Apple Silicon or /usr/local/bin on Intel), then run gh auth login.");
  }
  const catalog = requestedVersion ? await core.fetchAvailableVersions({ logger }) : await core.fetchLatestAvailableVersions({ logger });
  const selectedVersion = requestedVersion || catalog?.versions?.[0];
  if (!selectedVersion || !Array.isArray(catalog?.versions) || !Array.isArray(catalog.entries) ||
      !catalog.versions.includes(selectedVersion)) throw new Error("Requested MKXP-Z build is not in the available Actions catalog.");
  const entry = validateEntry(catalog.entries.find(item => item.version === selectedVersion), selectedVersion);
  if (selectedVersion === binary.version) return noChange(selectedVersion);
  // Only a different, validated artifact warrants owning an output directory.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(root, OWNER_FILE))) writeJson(root, [OWNER_FILE], { format: OWNER_FORMAT });
  let transfer = null;
  try {
    const reused = reuseCandidate(root, selectedVersion, binary, entry);
    if (reused) return reused;
    const transferPath = ownedPath(root, "transfers", `${selectedVersion}.json`);
    fs.mkdirSync(path.dirname(transferPath), { recursive: true, mode: 0o700 });
    const transferId = crypto.randomUUID();
    try {
      writeJson(root, ["transfers", `${selectedVersion}.json`], { id: transferId,
        pid: process.pid, startedAt: new Date().toISOString(), actions: entry });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("This MKXP-Z candidate transfer is active or interrupted; inspect its private transfer record before retrying.");
      throw error;
    }
    transfer = { path: transferPath, id: transferId };
    const installDir = ownedPath(root, "runtimes/mkxpz", selectedVersion);
    // Never let the core installer's replace-on-failure behavior touch a prior
    // candidate. An interrupted completed install can be reviewed in place.
    const existing = fs.existsSync(installDir);
    const install = existing ? null : await core.installFromGh({ userDataDir: root, entry, logger });
    if (!existing && !install) throw new Error("MKXP-Z download returned no candidate descriptor.");
    const inspected = inspectCandidate(root, entry, binary, install);
    const receipt = { format: RECEIPT_FORMAT, status: "pending-review", fetchedAt: new Date().toISOString(),
      actions: entry, runUrl: `https://github.com/${REPOSITORY}/actions/runs/${entry.runId}`,
      artifactUrl: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${entry.artifactId}`,
      ...inspected,
      proposedPin: proposedPin(entry, binary, inspected) };
    const receiptPath = writeJson(root, ["reviews", `${selectedVersion}.json`], receipt);
    logger?.info?.(`[mkxpz] candidate ${selectedVersion} retained for review: ${receiptPath}`);
    return { updated: false, downloaded: !existing, reused: existing, version: selectedVersion, candidate: receipt,
      receiptPath, appPath: path.join(root, inspected.appRelativePath) };
  } catch (error) {
    // Preserve returned downloads and existing candidates. The shared manager
    // may clean its own partial transfer; the failure identity still survives.
    try {
      const failure = writeJson(root, ["failures", `${selectedVersion}-${crypto.randomUUID()}.json`], {
        format: RECEIPT_FORMAT, status: "failed", failedAt: new Date().toISOString(), actions: entry,
        error: String(error?.message || error) });
      logger?.warn?.(`[mkxpz] candidate failed; review retained output and ${failure}`);
    } catch {
      logger?.warn?.("[mkxpz] candidate failed; output retained, but the failure record could not be written safely.");
    }
    throw error;
  } finally {
    if (transfer && readJson(transfer.path).id === transfer.id) fs.unlinkSync(transfer.path);
  }
}

// Compatibility for callers of the old updater; this no longer publishes.
const updateMkxpzEmbedded = (options, dependencies) => fetchMkxpzCandidate(options, dependencies);

function usage(script = "scripts/autoupdate-mkxpz.js") {
  return `Usage: node ${script} [--version <Actions-version>] [--output <private-directory>] [--help]\n\nFetch one exact MKXP-Z Actions candidate for maintainer review; Included pins and payloads stay unchanged.\nDefault output: ${DEFAULT_OUTPUT}\nAn explicit output must be empty or already owned by this workflow, outside public source.\nCached explicit candidates are verified and reused offline. New downloads require gh auth login.\nInstall optional gh via Homebrew: /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel).\nSee docs/runtimes/MKXPZ.md for review and offline staging.\n`;
}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--help" || key === "-h") return { help: true };
    const name = { "--version": "version", "--output": "outputRoot" }[key];
    if (!name || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(usage());
    }
    options[name] = args[++i];
  }
  return options;
}

async function main(args, dependencies) {
  const options = parseArguments(args);
  if (options.help) { console.log(usage()); return null; }
  return fetchMkxpzCandidate(options, dependencies);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error?.message || error); process.exitCode = 1;
});

module.exports = { fetchMkxpzCandidate, updateMkxpzEmbedded, resolveOutput, validateEntry, parseArguments, usage, main };

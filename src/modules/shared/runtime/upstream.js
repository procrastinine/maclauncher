const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Transport = require("./upstream-transport");
const { throwIfAborted } = require("./download-utils");

// Everything MacLauncher downloads at run time from an upstream publisher goes
// through a source made here. A source says where the publisher lists its
// releases and how the publisher verifies its files. Versions, checksums,
// sizes and file names come only from what the publisher returns, so a source
// has no field for any of them, and a field outside a kind's list is dropped.
//
// Files inside the app and MacLauncher Builds packages are not upstream
// downloads; they keep their own reproducible records.

const KINDS = Object.freeze({
  github: ["repository", "prerelease", "recognize", "allArchitectures"],
  githubCommits: ["repository", "branch", "recognize", "limit"],
  githubActions: ["repository", "workflow", "branch", "event", "recognize", "limit", "maxRuns", "allArchitectures"],
  index: ["locations", "hosts", "parse", "allArchitectures"],
  pypi: ["project", "recognize"],
  nuget: ["id", "recognize"],
  vendor: ["location", "teamIdentifier"],
  service: ["hosts"]
});
const ROW_FIELDS = ["version", "revision", "sourceUrl", "publishedAt", "prerelease", "channel", "installReason", "architecture", "label", "details"];
function pick(kind, spec, fields = KINDS[kind]) {
  return Object.fromEntries(Object.entries(spec || {}).filter(([key]) => fields.includes(key)));
}

// --- Rows and files ----------------------------------------------------------

const DIGESTS = [["sha512", /^[a-f0-9]{128}$/i, 64], ["sha256", /^[a-f0-9]{64}$/i, 32], ["sha1", /^[a-f0-9]{40}$/i, 20], ["md5", /^[a-f0-9]{32}$/i, 16]];
// A publisher digest as hex, `algorithm:hex` or base64; null when unreadable.
function readDigest(value, algorithm) {
  if (value && typeof value === "object") return readDigest(value.value, value.algorithm);
  const text = String(value || "").trim(), prefixed = /^(sha-?512|sha-?256|sha-?1|md5)[:=](.+)$/i.exec(text);
  const named = String(prefixed?.[1] || algorithm || "").toLowerCase().replace("-", ""), raw = prefixed ? prefixed[2] : text;
  for (const [name, hex, bytes] of DIGESTS) {
    if (named && named !== name) continue;
    if (hex.test(raw)) return { algorithm: name, value: raw.toLowerCase() };
    if (named === name && /^[A-Za-z0-9+/]+=*$/.test(raw) && Buffer.from(raw, "base64").length === bytes)
      return { algorithm: name, value: Buffer.from(raw, "base64").toString("hex") };
    // Some publishers base64-encode the hex text instead of the digest bytes.
    if (named === name && /^[A-Za-z0-9+/]+=*$/.test(raw) && hex.test(Buffer.from(raw, "base64").toString("latin1")))
      return { algorithm: name, value: Buffer.from(raw, "base64").toString("latin1").toLowerCase() };
  }
  return null;
}
function githubDigest(asset) { return readDigest(asset?.digest); }
function safeName(name, url) {
  const base = path.basename(String(name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "download")));
  return base && ![".", ".."].includes(base) && !base.includes("\0") ? base : "download";
}
// A file of a listed release. The digest and size count only when the
// publisher returned them (`evidence`); otherwise the hash is recorded at install.
function file(input, evidence) {
  let url;
  try { url = new URL(String(input?.url || "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const digest = readDigest(input.digest, input.algorithm), bytes = Number(input.bytes);
  const stated = value => evidence === true || typeof evidence === "string" && evidence.includes(String(value).toLowerCase());
  return Object.freeze({ name: safeName(input.name, url.href), url: url.href,
    ...(Number.isSafeInteger(bytes) && bytes > 0 && stated(bytes) ? { bytes } : {}),
    ...(digest && stated(typeof input.digest === "object" ? input.digest.value : input.digest) ? { digest: Object.freeze(digest) } : {}),
    ...(input.architecture ? { architecture: String(input.architecture) } : {}), ...(input.id != null ? { id: input.id } : {}) });
}
function row(spec, files, kind) {
  const fields = pick(`${kind} row`, spec, [...ROW_FIELDS, "files", "assets", "artifacts", "paths"]);
  const version = String(fields.version ?? "").trim();
  if (!version) return null;
  const out = { version, files: Object.freeze(files.filter(Boolean)) };
  for (const key of ROW_FIELDS.slice(1)) if (fields[key] != null) out[key] = key === "prerelease" ? Boolean(fields[key]) : fields[key];
  return Object.freeze(out);
}
const many = value => Array.isArray(value) ? value : value ? [value] : [];

// --- Discovery kinds -----------------------------------------------------------

function repository(value) {
  const [owner, repo, extra] = String(value || "").split("/");
  return /^[A-Za-z0-9_.-]+$/.test(owner || "") && /^[A-Za-z0-9_.-]+$/.test(repo || "") && extra === undefined ? { owner, repo } : null;
}
function source(kind, spec, discover, extra = {}) {
  return Object.freeze({ kind, ...spec, discover, download, ...extra });
}
// GitHub releases: `recognize(release, { arch, sourceUrl, revision, readSource })`
// returns rows whose `assets` are objects from `release.assets`. Their URL,
// size and digest are the publisher's; a release `recognize` cannot read is
// skipped. `readSource(path)` reads a text file of the repository at the
// release's revision, for a version the publisher states only in its source.
function github(spec) {
  const { repository: name, prerelease = false, recognize, allArchitectures = false } = pick("github", spec);
  const { owner, repo } = repository(name) || {};
  const discover = options => require("./github-runtime-catalog").createGithubReleaseDiscovery({ owner, repo, includePrerelease: prerelease, allArchitectures,
    mapRelease: async (release, context) => {
      const revision = await context.resolveRevision(release);
      const assets = new Set(release.assets || []);
      const readSource = async relative => {
        const response = await Transport.fetchUrlBuffer(`https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${String(relative).split("/").map(encodeURIComponent).join("/")}`,
          { signal: options?.signal, headers: { "User-Agent": "maclauncher" } });
        if (response.status !== 200 || response.body.length > 1024 * 1024) throw new Error(`${relative} is unavailable at ${owner}/${repo} ${revision}.`);
        return response.body.toString("utf8");
      };
      return many(await recognize(release, { sourceUrl: context.sourceUrl, arch: options?.arch, revision, readSource })).map(item => row({ revision, sourceUrl: context.sourceUrl,
        publishedAt: release.published_at, prerelease: release.prerelease, ...item }, many(item?.assets).filter(asset => assets.has(asset)).map(asset =>
        file({ name: asset.name, url: asset.browser_download_url, bytes: asset.size, digest: asset.digest, id: asset.id }, true)), "github")).filter(Boolean);
    } })(options);
  return source("github", { repository: name }, Object.assign(discover, { allArchitectures }));
}
// Commits of a branch: each listed revision is immutable. `recognize(commit)`
// returns rows; `paths` become raw files and `archive: true` the source archive
// at that revision.
function githubCommits(spec) {
  const { repository: name, branch, recognize = () => ({}), limit = 20 } = pick("githubCommits", spec);
  const { owner, repo } = repository(name) || {};
  const discover = require("./github-runtime-catalog").createGithubCommitDiscovery({ owner, repo, limit, ...(branch ? { branch } : {}), mapCommit: async (commit, context) => {
    const sha = String(commit.sha).toLowerCase(), base = require("./github-runtime-catalog").githubCommitSource(commit, { owner, repo, head: context.head });
    return many(await recognize(commit, { ...context, revision: sha })).map(item => row({ version: base.version, revision: sha, sourceUrl: base.sourceUrl,
      publishedAt: base.committedAt, label: base.versionLabel, ...item }, [
      ...(item?.archive ? [file({ name: `${repo}-${sha}.zip`, url: base.url })] : []),
      ...many(item?.paths).map(relative => file({ name: path.basename(relative), url: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${relative}` }))
    ], "githubCommits")).filter(Boolean);
  } });
  return source("githubCommits", { repository: name }, async options => (await discover(options)).flat());
}
// Public Actions artifacts of a workflow. `recognize(artifact, { run })` returns
// rows; each recognized artifact is one file with GitHub's digest.
function githubActions(spec) {
  const { repository: name, workflow, branch, event, recognize, limit, maxRuns, allArchitectures = false } = pick("githubActions", spec);
  const { owner, repo } = repository(name) || {};
  const Actions = require("./github-actions-catalog");
  const discover = Actions.createGithubActionsDiscovery({ owner, repo, workflow, ...(branch ? { branch } : {}), ...(event ? { event } : {}),
    ...(limit ? { limit } : {}), ...(maxRuns ? { maxRuns } : {}),
    mapArtifact: async (artifact, context) => many(await recognize(artifact, context)).map(item => row({ revision: context.run.head_sha.toLowerCase(),
      sourceUrl: context.sourceUrl, publishedAt: context.run.created_at, ...item }, [file({ name: `${artifact.name}.zip`,
      url: context.nightlyArtifactUrl(), bytes: artifact.size_in_bytes, digest: artifact.digest, id: artifact.id }, true)], "githubActions")).filter(Boolean) });
  return source("githubActions", { repository: name }, Object.assign(options => discover(options), { allArchitectures }));
}
function hostAllowed(url, hosts) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}
// Feeds, listings and vendor APIs. `parse(documents, { arch, fetch })` reads
// the publisher's responses and returns rows with `files` ({ name, url, bytes,
// digest }). A digest or size counts only when a response contains it.
// `fetch(url, { method: "HEAD" })` reads a file's headers without its body.
function index(spec) {
  const { locations, hosts, parse, allArchitectures = false } = pick("index", spec);
  const places = many(locations).map(String), allowed = many(hosts).length ? many(hosts).map(host => String(host).toLowerCase())
    : places.map(place => { try { return new URL(place).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean);
  const discover = async ({ signal, logger, arch, latestOnly } = {}) => {
    const documents = [];
    const fetch = async (url, { method } = {}) => {
      if (!hostAllowed(url, allowed)) return null;
      throwIfAborted(signal);
      const response = await Transport.fetchUrlBuffer(url, { signal, headers: { "User-Agent": "maclauncher" }, ...(method === "HEAD" ? { method } : {}) });
      // A compressed answer (NuGet's registration pages always are) is read decoded.
      const document = { url, status: response.status, headers: response.headers || {},
        text: require("./download-utils").decodeResponseBody(response.body, response.headers).toString("utf8") };
      documents.push(document);
      return document;
    };
    let failure = null;
    for (const place of places) {
      try { const document = await fetch(place); if (document && document.status !== 200) throw new Error(`${place} answered ${document.status}.`); }
      catch (error) { if (signal?.aborted) throw error; failure ||= error; logger?.warn?.(`[upstream] ${place}: ${error.message || error}`); }
    }
    if (!documents.some(document => document.status === 200)) throw failure || new Error("The publisher's release list is unavailable.");
    const rows = many(await parse(documents.filter(document => document.status === 200), { arch, fetch, latestOnly, logger }));
    // Read once, after parse has fetched what it needs.
    const evidence = documents.map(document => `${document.text}\n${Object.values(document.headers).join("\n")}`).join("\n").toLowerCase();
    return rows.map(item => row(item, many(item?.files).filter(entry => hostAllowed(entry?.url, allowed)).map(entry => file(entry, evidence)), "index")).filter(Boolean);
  };
  return source("index", { locations: places, hosts: allowed }, Object.assign(discover, { allArchitectures }));
}
// A PyPI project: every non-yanked file with the SHA-256 PyPI publishes.
// `recognize({ version, files, info })` may narrow a release's files.
function pypi(spec) {
  const { project, recognize = release => ({ version: release.version, files: release.files }) } = pick("pypi", spec);
  const name = String(project || "");
  return index({ locations: [`https://pypi.org/pypi/${encodeURIComponent(name)}/json`], hosts: ["pypi.org", "pythonhosted.org"],
    parse: async ([document]) => {
      const data = JSON.parse(document.text), releases = data?.releases && typeof data.releases === "object" ? data.releases
        : { [data?.info?.version]: data?.urls || [] };
      const rows = [];
      for (const [version, uploads] of Object.entries(releases)) {
        const files = many(uploads).filter(upload => upload && !upload.yanked && upload.url)
          .map(upload => ({ name: upload.filename, url: upload.url, bytes: upload.size, digest: upload.digests?.sha256, details: upload }));
        if (!files.length) continue;
        for (const item of many(await recognize({ version, files, info: data.info })))
          rows.push({ version: item.version || version, publishedAt: item.files?.[0]?.details?.upload_time_iso_8601, ...item });
      }
      return rows;
    } });
}
// A NuGet package: versions from the registration index, packages with the
// SHA-512 NuGet publishes in each catalog entry.
function nuget(spec) {
  const { id, recognize = release => ({ version: release.version, files: release.files }) } = pick("nuget", spec);
  const lower = String(id || "").toLowerCase();
  return index({ locations: ["https://api.nuget.org/v3/index.json"], hosts: ["nuget.org"], parse: async ([service], { fetch }) => {
    const resources = many(JSON.parse(service.text)?.resources).filter(item => /^RegistrationsBaseUrl/.test(item?.["@type"] || ""));
    const base = (resources.find(item => /3\.6\.0/.test(item["@type"])) || resources[0])?.["@id"];
    if (!base) return [];
    const registration = await fetch(`${base.replace(/\/?$/, "/")}${lower}/index.json`);
    const pages = many(registration && JSON.parse(registration.text)?.items), rows = [];
    for (const page of pages) {
      let items = page?.items;
      if (!Array.isArray(items) && page?.["@id"]) { try { items = JSON.parse((await fetch(page["@id"]))?.text || "{}").items; } catch { items = []; } }
      for (const item of many(items)) {
        const entry = item?.catalogEntry;
        if (!entry?.version || entry.listed === false || !item.packageContent) continue;
        let leaf = entry;
        try { if (!entry.packageHash && entry["@id"]) leaf = { ...entry, ...JSON.parse((await fetch(entry["@id"]))?.text || "{}") }; } catch {}
        for (const recognized of many(await recognize({ version: entry.version, entry: leaf, files: [{ name: `${lower}.${entry.version}.nupkg`,
          url: item.packageContent, bytes: leaf.packageSize, digest: leaf.packageHash, algorithm: leaf.packageHashAlgorithm }] })))
          rows.push({ version: entry.version, publishedAt: entry.published, ...recognized });
      }
    }
    return rows;
  } });
}
// A file the vendor documents at one location and replaces in place. Its
// version is read from the file; the vendor's Developer ID signature verifies it.
function vendor(spec) {
  const { location, teamIdentifier } = pick("vendor", spec);
  const listed = file({ url: location });
  return source("vendor", { location, teamIdentifier }, async () => listed ? [row({ version: "current", sourceUrl: location }, [listed], "vendor")] : [], {
    verifySigner: (target, options) => require("./developer-id").verifyDeveloperId(target, teamIdentifier, options) });
}
// An authenticated store API (Google Play, GOG, Epic). Its delivery responses
// name each file and the digest that verifies it.
function service(spec) {
  const { hosts } = pick("service", spec);
  const allowed = many(hosts).map(host => String(host).toLowerCase());
  return source("service", { hosts: allowed }, async () => [], {
    request: (url, options) => Transport.fetchUrlBuffer(url, options),
    file: (input, evidence = true) => hostAllowed(input?.url, allowed) ? file(input, typeof evidence === "string" ? evidence.toLowerCase() : evidence) : null });
}

// --- Downloads -----------------------------------------------------------------

function hashFile(target, algorithm) {
  const hash = crypto.createHash(algorithm), descriptor = fs.openSync(target, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let read; while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}
// Downloads a listed file. It is checked against the publisher's size and
// digest when the publisher gave them; otherwise its SHA-256 is recorded.
async function download(listed, destination, { signal, onProgress, headers } = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await Transport.downloadToFile(listed.url, destination, { signal, onProgress, ...(headers ? { headers } : {}) });
  throwIfAborted(signal);
  const bytes = fs.statSync(destination).size, sha256 = hashFile(destination, "sha256");
  if (listed.bytes !== undefined && bytes !== listed.bytes) throw new Error(`${listed.name} does not match the size its publisher lists. Nothing was installed.`);
  const digest = listed.digest && (listed.digest.algorithm === "sha256" ? sha256 : hashFile(destination, listed.digest.algorithm));
  if (listed.digest && digest !== listed.digest.value) throw new Error(`${listed.name} does not match the checksum its publisher lists. Nothing was installed.`);
  return { path: destination, bytes, sha256, integrity: listed.digest ? `publisher-${listed.digest.algorithm}` : "recorded-local" };
}

// A listed file as a runtime-catalog row asset (the shape stored in caches and
// install receipts).
function asset(listed) {
  if (!listed) return null;
  return { filename: listed.name, url: listed.url, ...(listed.bytes ? { bytes: listed.bytes } : {}),
    ...(listed.id != null && Number.isSafeInteger(listed.id) ? { assetId: listed.id } : {}),
    ...(listed.digest?.algorithm === "sha256" ? { sha256: listed.digest.value } : { integrity: "recorded-local",
      ...(listed.digest ? { digest: { ...listed.digest } } : {}) }) };
}
// The row's assets as cache file shape back to a listed file.
function listedFile(cached) {
  return file({ name: cached?.filename, url: cached?.url, bytes: cached?.bytes, id: cached?.assetId,
    digest: cached?.sha256 ? { algorithm: "sha256", value: cached.sha256 } : cached?.digest }, true);
}

// A GitHub repository's license notice at the exact revision of a listed
// release, for downloads that carry none. A notice moved or named otherwise is
// found through GitHub's license lookup. Null when the repository publishes
// none; the download proceeds without a notice.
function githubLicense({ repository: name, revision, destination, signal }) {
  const { owner, repo } = repository(name) || {};
  return require("./github-releases").fetchGithubLicense({ owner, repo, revision, destination, signal,
    request: (url, options) => Transport.fetchUrlBuffer(url, options),
    download: (url, target, options) => Transport.downloadToFile(url, target, options) });
}

// The file tree GitHub lists for a commit: each path with its size and Git
// blob SHA-1.
async function githubTree({ repository: name, revision, signal }) {
  const { owner, repo } = repository(name) || {};
  if (!owner || !/^[A-Za-z0-9_.-]+$/.test(revision || "")) throw new Error("Invalid GitHub tree lookup.");
  const response = await require("./github-transport").request(`https://api.github.com/repos/${owner}/${repo}/git/trees/${revision}?recursive=1`,
    { signal, maxBytes: 8 << 20, headers: { "User-Agent": "maclauncher", Accept: "application/vnd.github+json" } });
  if (response.status !== 200) throw Object.assign(new Error(`The source listing could not be read (${response.status}).`), { status: response.status });
  return JSON.parse(require("./download-utils").decodeResponseBody(response.body, response.headers, { maxBytes: 8 << 20 }).toString("utf8"));
}
// Bytes `start` to `start + length - 1` of a listed file, for a large archive
// read in parts. Returns the bytes and the file's total size.
async function range(listed, start, length, { signal } = {}) {
  const end = start + length - 1;
  const response = await Transport.fetchUrlBuffer(listed.url, { signal, maxBytes: length,
    headers: { "User-Agent": "maclauncher", Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" } });
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers?.["content-range"] || "");
  if (response.status !== 206 || Number(match?.[1]) !== start || Number(match?.[2]) !== end || response.body.length !== length)
    throw new Error(`${listed.name} could not be read in parts from its publisher.`);
  return { bytes: response.body, total: Number(match[3]) };
}

module.exports = {
  github, githubCommits, githubActions, index, pypi, nuget, vendor, service,
  download, asset, listedFile, readDigest, githubDigest, githubLicense, githubTree, range,
  KINDS
};

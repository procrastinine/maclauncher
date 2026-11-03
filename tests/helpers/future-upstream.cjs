// Offline "future upstream" harness. A fixture describes a publisher's current
// release metadata as URL responses; the harness derives what the publisher may
// publish later (a new version, a renamed or added asset, a file replaced behind
// the same URL, a deleted release, extra unknown fields) and checks that each
// runtime manager uses or cleanly skips every change while its earlier list,
// cache and installations keep working.
//
// Require this module before any MacLauncher module: it replaces the network
// functions, so destructured imports receive the offline versions.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const http = require("node:http"), https = require("node:https");
const Transport = require("../../src/modules/shared/runtime/github-transport");
const UpstreamTransport = require("../../src/modules/shared/runtime/upstream-transport");

const network = { routes: null, requests: [] };
function offlineError(url) { return Object.assign(new Error(`Offline test request: ${url}`), { code: "ENOTFOUND" }); }
// A route function receives the URL and the request options (method, headers).
function respond(url, options = {}) {
  network.requests.push(String(url));
  const handler = network.routes && lookup(network.routes, String(url));
  if (handler === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
  const value = typeof handler === "function" ? handler(String(url), options) : handler;
  if (value && typeof value === "object" && Number.isInteger(value.status) && "body" in value) return value;
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return { status: 200, headers: {}, body };
}
// Routes are keyed by URL without its query string; GitHub list pages after the
// first are empty.
function lookup(routes, url) {
  const parsed = new URL(url), page = Number(parsed.searchParams.get("page") || 1);
  const key = parsed.origin + parsed.pathname;
  if (page > 1 && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(?:releases|tags|commits)$/.test(key)) return [];
  return Object.hasOwn(routes, url) ? routes[url] : routes[key];
}
Transport.request = async url => respond(url);
UpstreamTransport.fetchUrlBuffer = async (url, options) => respond(url, options);
// A routed file download writes the route's body; anything else is offline.
UpstreamTransport.downloadToFile = async (url, destination, { onProgress } = {}) => {
  if (!network.routes || lookup(network.routes, String(url)) === undefined) { network.requests.push(String(url)); throw offlineError(url); }
  const { status, body } = respond(url);
  if (status !== 200) throw Object.assign(new Error(`HTTP ${status} for ${url}`), { statusCode: status });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body);
  onProgress?.({ downloaded: body.length, total: body.length });
  return { downloaded: body.length, total: body.length };
};
https.request = https.get = http.request = http.get = url => { throw offlineError(url); };
globalThis.fetch = async url => { throw offlineError(url); };

// --- GitHub-shaped publishers -------------------------------------------------

const API = "https://api.github.com/repos/";
function githubRoutes(repository, releases) {
  const routes = { [`${API}${repository}/releases`]: releases,
    [`${API}${repository}/tags`]: releases.map(release => ({ name: release.tag_name, commit: { sha: revision(release.tag_name) } })) };
  for (const release of releases)
    routes[`${API}${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`] = { object: { type: "commit", sha: revision(release.tag_name) } };
  return routes;
}
function revision(text) { return require("node:crypto").createHash("sha1").update(String(text)).digest("hex"); }
function digest(text) { return "sha256:" + require("node:crypto").createHash("sha256").update(String(text)).digest("hex"); }
// A release in GitHub's API shape. Assets are names; each gets a download URL,
// a size and the digest GitHub publishes.
function githubRelease(repository, tag, assets, extra = {}) {
  return { id: Number.parseInt(revision(repository + tag).slice(0, 8), 16), tag_name: tag, name: tag, draft: false, prerelease: false,
    html_url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`, published_at: "2026-01-01T00:00:00Z",
    assets: assets.map((name, index) => githubAsset(repository, tag, name, index)), ...extra };
}
function githubAsset(repository, tag, name, index = 0) {
  return { id: Number.parseInt(revision(repository + tag + name).slice(0, 8), 16) + index, name, size: 4096 + index,
    content_type: "application/octet-stream", digest: digest(repository + tag + name),
    browser_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` };
}

// Scenario builders for a list of GitHub releases, newest first. `bump` turns
// the newest version string into a later one.
function githubScenarios(repository, releases, { bump = nextVersion, version = tagVersion, rename = renameAsset } = {}) {
  const newest = releases[0], current = version(newest.tag_name), next = bump(current);
  const retag = (release, from, to) => githubRelease(repository, release.tag_name.split(from).join(to),
    release.assets.map(asset => asset.name.split(from).join(to)));
  return {
    newVersion: { routes: githubRoutes(repository, [retag(newest, current, next), ...releases]), version: next, usable: true },
    renamedAsset: { routes: githubRoutes(repository, [githubRelease(repository, retag(newest, current, next).tag_name,
      retag(newest, current, next).assets.map(asset => rename(asset.name))), ...releases]), version: next, usable: "either" },
    addedAsset: { routes: githubRoutes(repository, [githubRelease(repository, retag(newest, current, next).tag_name,
      [...retag(newest, current, next).assets.map(asset => asset.name), ...extraAssets(retag(newest, current, next).assets)]), ...releases]),
    version: next, usable: true },
    replacedFile: { routes: githubRoutes(repository, [{ ...newest, assets: newest.assets.map(asset => ({ ...asset, size: asset.size + 1,
      digest: digest("replaced " + asset.name) })) }, ...releases.slice(1)]), version: current, usable: true,
    digests: newest.assets.map(asset => digest("replaced " + asset.name).slice(7)) },
    deletedRelease: releases.length > 1 ? { routes: githubRoutes(repository, releases.slice(0, -1)), version: current, usable: true,
      deleted: version(releases.at(-1).tag_name) } : null
  };
}
function tagVersion(tag) { return /\d+(?:\.\d+)+/.exec(tag)?.[0] || tag; }
function nextVersion(version) {
  const parts = version.split(".");
  parts[0] = String(Number(parts[0]) + 1);
  return parts.map((part, index) => index === 0 ? part : part.replace(/\d+/, "0")).join(".");
}
// A publisher renames an asset: a new CPU word or a different archive format.
function renameAsset(name) {
  return name.replace(/\.(tar\.xz|tar\.gz|tgz|zip|dmg|7z)$/i, (_, extension) => "-macos-universal." + (extension.toLowerCase() === "zip" ? "tar.xz" : "zip"));
}
// A publisher adds assets next to the existing ones: another CPU, a checksum
// file, a debug archive and a different platform.
function extraAssets(assets) {
  const stem = assets[0]?.name.replace(/\.[^.]+$/, "") || "release";
  return [`${stem}-riscv64.tar.gz`, `${stem}.sha256`, `${stem}-debug-symbols.zip`, `${stem}-linux-aarch64.AppImage`];
}

// --- Generic mutations ---------------------------------------------------------

// Adds fields no released MacLauncher knows to every object in a JSON value.
function withUnknownFields(value) {
  if (Array.isArray(value)) return value.map(withUnknownFields);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withUnknownFields(item)])),
    future_field: { nested: [1, "two", null], enabled: true }, futureFlag: "unrecognized-value" };
}
function mapRoutes(routes, map) {
  return Object.fromEntries(Object.entries(routes).map(([url, value]) => [url, typeof value === "function" ? (...args) => map(value(...args)) : map(value)]));
}

// --- Assertions ----------------------------------------------------------------

function catalogs(state, found = []) {
  if (!state || typeof state !== "object") return found;
  if (state.catalog && typeof state.catalog === "object") found.push(state.catalog);
  for (const section of state.sections || []) if (section !== state) catalogs(section, found);
  for (const catalog of Object.values(state.catalog?.architectureCatalogs || {})) found.push(catalog);
  return found;
}
function listed(manager, userDataDir) {
  const state = manager.getState({ userDataDir, settings: {} }), versions = new Map();
  for (const catalog of catalogs(state)) for (const version of catalog.versions || [])
    if (!versions.has(version) || !catalog.versionRequirements?.[version]?.installReason)
      versions.set(version, catalog.versionRequirements?.[version]?.installReason || null);
  return versions;
}
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), "future-upstream-")); }
async function refresh(manager, userDataDir, routes) {
  network.routes = routes;
  try { return await manager.refreshCatalog({ userDataDir, force: true }); } finally { network.routes = null; }
}

// Runs every scenario for one manager. `fixture.current` holds the publisher's
// current routes; `fixture.scenarios` the derived future states.
async function checkManager(t, manager, fixture) {
  const label = manager.id, directories = [];
  t.after(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); });
  const fresh = () => { const directory = temporary(); directories.push(directory); return directory; };

  const baseDir = fresh();
  await refresh(manager, baseDir, fixture.current);
  const before = listed(manager, baseDir);
  assert.ok(before.size, `${label}: the fixture lists no version`);
  const usable = [...before].filter(([, reason]) => !reason).map(([version]) => version);

  const unknownDir = fresh();
  await refresh(manager, unknownDir, mapRoutes(fixture.current, withUnknownFields));
  assert.deepEqual([...listed(manager, unknownDir).keys()].sort(), [...before.keys()].sort(), `${label}: unknown metadata fields changed the list`);

  for (const [name, scenario] of Object.entries(fixture.scenarios || {})) {
    if (!scenario) continue;
    const directory = fresh();
    await refresh(manager, directory, scenario.routes);
    const after = listed(manager, directory), deleted = [scenario.deleted].flat().filter(Boolean);
    for (const version of usable) if (!deleted.includes(version))
      assert.ok(after.has(version), `${label} ${name}: ${version} disappeared`);
    if (scenario.version) {
      assert.ok(after.has(scenario.version) || scenario.usable === "either", `${label} ${name}: ${scenario.version} is not listed`);
      if (scenario.usable === true) assert.equal(after.get(scenario.version), null, `${label} ${name}: ${scenario.version} is not installable: ${after.get(scenario.version)}`);
      if (after.has(scenario.version) && after.get(scenario.version)) assert.ok(after.get(scenario.version).length > 8, `${label} ${name}: a skipped version needs a reason`);
    }
    const discovered = typeof manager.core?.listDiscoveredCatalog === "function" ? manager.core.listDiscoveredCatalog({ userDataDir: directory }) : [];
    // A file replaced behind the same URL is verified against the publisher's new digest.
    if (scenario.digests) for (const row of discovered.filter(row => row.version === scenario.version && row.asset?.sha256))
      assert.ok(scenario.digests.includes(row.asset.sha256), `${label} ${name}: ${row.version} keeps a fixed checksum`);
    // An installation of a release upstream deleted stays known offline.
    // `deleted` names one version or, for a release listed once per CPU, several.
    if (deleted.length && typeof manager.core?.getInstallDir === "function" && typeof manager.core?.listDiscoveredCatalog === "function") {
      const pin = manager.core.listDiscoveredCatalog({ userDataDir: baseDir }).find(row => deleted.includes(row.version));
      if (pin) {
        const target = manager.core.getInstallDir({ userDataDir: directory, version: pin.version });
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "runtime.json"), JSON.stringify({ version: pin.version, upstreamRevision: pin.upstreamRevision,
          catalogEntry: pin, source: "download", binarySha256: "c".repeat(64), executableRelative: "runtime", archiveSha256: pin.asset?.sha256 }));
        const state = manager.getState({ userDataDir: directory, settings: {} });
        assert.ok(catalogs(state).some(catalog => catalog.versionRequirements?.[pin.version]), `${label} ${name}: the installed ${pin.version} is no longer known`);
      }
    }
  }

  // A failed or malformed answer after a good one keeps the list. Managers
  // that keep one catalog in memory hold the last scenario's list here, so the
  // current answer is read again first.
  await refresh(manager, baseDir, fixture.current);
  for (const broken of [{}, mapRoutes(fixture.current, () => ({ status: 500, headers: {}, body: Buffer.from("unavailable") })),
    mapRoutes(fixture.current, () => Buffer.from("{ not json"))]) {
    await refresh(manager, baseDir, broken).catch(() => {});
    assert.deepEqual([...listed(manager, baseDir).keys()].sort(), [...before.keys()].sort(), `${label}: a failed refresh changed the cached list`);
  }

  if (fixture.layout) await checkLayout(t, fixture.layout, label);

  // A saved default that upstream deleted gives way instead of blocking Play.
  if (typeof manager.resolveSelection === "function" && fixture.savedDefault !== false) {
    const selection = manager.resolveSelection({}, { runtimes: { [manager.id]: { defaultVersion: "0.0.1-removed" } } }, baseDir);
    assert.notEqual(selection?.version, "0.0.1-removed", `${label}: a deleted saved default blocks selection`);
  }
}

// A publisher moves files inside its package: everything one folder deeper,
// next to unrelated files. `layout.write(root)` writes the current layout and
// returns the relative path `layout.resolve(root)` must find, absolute or
// relative to root.
async function checkLayout(t, layout, label = "layout") {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flat = path.join(root, "flat"), nested = path.join(root, "nested"), wrapper = "Release 99.0 (macOS universal)";
  fs.mkdirSync(flat);
  fs.mkdirSync(path.join(nested, wrapper), { recursive: true });
  const expected = await layout.write(flat);
  await layout.write(path.join(nested, wrapper));
  fs.writeFileSync(path.join(nested, "README.txt"), "Release notes\n");
  fs.mkdirSync(path.join(nested, "__MACOSX"));
  const found = async directory => { const value = await layout.resolve(directory); return path.relative(directory, path.resolve(directory, value)); };
  assert.equal(await found(flat), path.normalize(expected), `${label}: the current layout is not found`);
  assert.equal(await found(nested), path.join(wrapper, expected), `${label}: a layout moved into a folder is not found`);
}

module.exports = { network, githubRoutes, githubRelease, githubAsset, githubScenarios, withUnknownFields, mapRoutes, catalogs, listed,
  checkManager, checkLayout, nextVersion, renameAsset, extraAssets };

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Github = require("../src/modules/shared/runtime/github-releases");
const { createGithubReleaseDiscovery, githubAssetDigest } = require("../src/modules/shared/runtime/github-runtime-catalog");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const { readRuntimeCatalog } = require("../src/modules/shared/runtime/runtime-catalog");

const temporary = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
};
const response = (entries, next) => ({ status: 200, body: Buffer.from(JSON.stringify(entries)), headers: next ? { link: `<${next}>; rel="next"` } : {} });
const revision = char => char.repeat(40);
const entry = (version, char = "a") => ({ version, upstreamRevision: revision(char), localBuild: false });
function binary() {
  const data = Buffer.alloc(32); data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4); data.writeUInt32LE(2, 12); return data;
}

test("a discoverable empty catalog stays offline and failed first queries remain retryable", async t => {
  const userDataDir = temporary(t); let calls = 0;
  const manager = createPinnedNativeManager({ id: "empty-remote", label: "Remote", catalog: [], discoverCatalog: async () => {
    if (++calls === 1) throw new Error("Offline");
    return [entry("2.0")];
  } });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(manager.getState({ userDataDir }).catalog.status, "idle");
  assert.equal(calls, 0);
  await assert.rejects(manager.refreshCatalog({ userDataDir }), /Offline/);
  const failed = manager.getState({ userDataDir }).catalog;
  assert.deepEqual(failed.versions, []); assert.equal(failed.fetchedAt, null);
  assert.equal(failed.status, "error");
  assert.deepEqual((await manager.refreshCatalog({ userDataDir })).versions, ["2.0"]);
  assert.equal(calls, 2);
  assert.throws(() => createPinnedNativeManager({ id: "empty-fixed", label: "Fixed", catalog: [] }), /version catalog/);
});

test("failed refresh retains the exact valid cache and successful refresh replaces and deduplicates remote rows", async t => {
  const userDataDir = temporary(t); let fail = false, calls = 0;
  const manager = createPinnedNativeManager({ id: "retained-cache", label: "Remote", catalog: [entry("factory", "f")], discoverCatalog: async () => {
    calls++; if (fail) throw new Error("Offline");
    return calls === 1 ? [entry("v1.2.3"), entry("1.2.3", "b"), entry("1.2.3-macos-v7", "c"), entry("older", "d")]
      : [entry("v1.2.3"), entry("1.2.3"), entry("1.2.3-macos-v8", "e")];
  } });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  const first = await manager.refreshCatalog({ userDataDir, latestOnly: false });
  assert.deepEqual(first.versions, ["1.2.3", "1.2.3-macos-v7", "older"]);
  const cacheFile = path.join(userDataDir, "runtimes", "retained-cache", "catalog.json"), cacheBytes = fs.readFileSync(cacheFile);
  fail = true;
  await assert.rejects(manager.refreshCatalog({ userDataDir, latestOnly: true }), /Offline/);
  const failed = manager.getState({ userDataDir }).catalog;
  assert.equal(failed.status, "error"); assert.equal(failed.mode, first.mode);
  assert.equal(failed.fetchedAt, first.fetchedAt); assert.deepEqual(failed.versions, first.versions);
  assert.deepEqual(fs.readFileSync(cacheFile), cacheBytes);
  fail = false;
  const refreshed = await manager.refreshCatalog({ userDataDir, latestOnly: false });
  assert.deepEqual(refreshed.versions, ["1.2.3", "1.2.3-macos-v8"]);
  assert.equal(calls, 3, "a failed query cannot satisfy the success TTL");
  assert.equal(manager.core.catalog.find(pin => pin.version === "factory").upstreamRevision, revision("f"));
});

test("ordinary GitHub releases enumerate bounded pages, canonical repository links and unique IDs", async () => {
  const requested = [];
  const releases = await Github.fetchGithubReleases({ owner: "Author", repo: "Engine",
    request: async url => {
      requested.push(url); const page = requested.length;
      return response([{ id: page, tag_name: `1.${page}` }, { id: 1, tag_name: "1.1" }, { id: 100 + page, draft: true }],
        `https://api.github.com/repositories/42/releases?per_page=100&page=${page + 1}`);
    } });
  assert.equal(requested.length, 5);
  assert.deepEqual(releases.map(item => item.id), [1, 2, 3, 4, 5]);
  await assert.rejects(() => Github.fetchGithubReleases({ owner: "a", repo: "b", request: async () => response([], "https://evil.invalid/releases") }), /escaped/);
  await assert.rejects(() => Github.fetchGithubReleases({ owner: "a", repo: "b", request: async () => response([], "https://api.github.com/repos/another/game/releases") }), /escaped/);
});

test("explicit larger GitHub history limits paginate beyond five pages and retain the complete offline cache", async t => {
  const userDataDir = temporary(t), requested = [];
  const releases = await Github.fetchGithubReleases({ owner: "a", repo: "b", maxPages: 10, request: async url => {
    requested.push(url); const page = requested.length;
    return response([{ id: page, tag_name: `0.0.1.${page}` }], page < 7 ? `https://api.github.com/repos/a/b/releases?per_page=100&page=${page + 1}` : null);
  } });
  assert.equal(requested.length, 7); assert.equal(releases.length, 7);
  const incoming = Array.from({ length: 657 }, (_, index) => entry(`0.0.1.${index + 1}`));
  let networkCalls = 0;
  const make = () => createPinnedNativeManager({ id: "large-history", label: "History", maxEntries: 1000,
    catalog: [entry("reviewed")], discoverCatalog: createGithubReleaseDiscovery({ owner: "a", repo: "b", maxPages: 10, maxEntries: 1000,
      dependencies: { fetchGithubReleases: async options => { networkCalls++; assert.equal(options.maxPages, 10); return incoming.map(row => ({ tag_name: row.version })); },
        fetchGithubTags: async options => { assert.equal(options.maxPages, 10); return incoming.map(row => ({ name: row.version, commit: { sha: row.upstreamRevision } })); } },
      mapRelease: async (release, context) => ({ version: release.tag_name, upstreamRevision: await context.resolveRevision(release), localBuild: false }) }) });
  const manager = make(); await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(manager.getState({ userDataDir }).catalog.versions.length, 657);
  assert.equal(readRuntimeCatalog({ userDataDir, managerId: "large-history" }), null, "default cache limit remains 500");
  assert.equal(readRuntimeCatalog({ userDataDir, managerId: "large-history", maxEntries: 1000 }).entries.length, 657);
  assert.equal(make().getState({ userDataDir }).catalog.versions.length, 657);
  assert.equal(networkCalls, 1, "restarted state uses the large cache without querying upstream");
  assert.throws(() => createGithubReleaseDiscovery({ owner: "a", repo: "b", maxPages: 21, mapRelease: () => null }), /limits/);
  assert.throws(() => createPinnedNativeManager({ id: "over-limit", label: "Limit", catalog: [entry("base")], maxEntries: 2001 }), /limit/);
});

test("tag resolution peels annotated tags and shared providers batch tag identities", async () => {
  const lookedUp = [];
  const commit = await Github.resolveGithubTagCommit({ owner: "a", repo: "b", tag: "1.16", request: async url => {
    lookedUp.push(url);
    return response({ object: { type: lookedUp.length === 1 ? "tag" : "commit", sha: revision(lookedUp.length === 1 ? "a" : "b") } });
  } });
  assert.equal(commit, revision("b")); assert.equal(lookedUp.length, 2);
  const discover = createGithubReleaseDiscovery({ owner: "a", repo: "b", dependencies: {
    fetchGithubReleases: async options => { assert.equal(options.maxPages, 5); return [{ tag_name: "1.16", target_commitish: "master" }]; },
    fetchGithubTags: async () => [{ name: "1.16", commit: { sha: revision("c") } }],
    resolveGithubTagCommit: async () => { throw new Error("one request per tag should not be needed"); }
  }, mapRelease: async (release, tools) => ({ version: release.tag_name, upstreamRevision: await tools.resolveRevision(release) }) });
  assert.deepEqual(await discover(), [{ version: "1.16", upstreamRevision: revision("c") }]);
  assert.equal(githubAssetDigest({ digest: "sha256:" + "d".repeat(64) }), "d".repeat(64));
  assert.equal(githubAssetDigest({ digest: "sha512:wrong" }), null);
});

test("refresh replaces its remote list, canonicalizes numeric tags and retains a single reviewed base build", async t => {
  const userDataDir = temporary(t); let calls = 0;
  const make = () => createPinnedNativeManager({ id: "catalog-test", label: "Catalog", supportsDefault: true,
    catalog: [entry("1.8.0", "f")], discoverCatalog: async options => {
      calls++; assert.equal(options.latestOnly, false);
      return calls === 1 ? [entry("v1.8.0", "a"), entry("1.7.0", "b")] : [entry("v1.8.0", "a"), entry("1.9.0", "c")];
    } });
  const manager = make();
  assert.equal(calls, 0); assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, []);
  assert.equal(manager.getState({ userDataDir }).catalog.recommendedVersion, undefined);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).version, null, "A base profile is not a package-wide choice");
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["1.8.0", "1.7.0"]);
  await manager.refreshCatalog({ userDataDir, force: true });
  const catalog = manager.getState({ userDataDir }).catalog;
  assert.deepEqual(catalog.versions, ["1.8.0", "1.9.0"]);
  assert.equal(catalog.recommendedVersion, undefined);
  assert.equal(manager.resolveSelection({}, {}, userDataDir).selectionRequired, true, "Refresh lists choices without selecting one");
  const settings = { runtimes: { "catalog-test": { defaultVersion: "1.8.0" } } };
  assert.equal(manager.resolveSelection({}, settings, userDataDir).version, "1.8.0", "An explicit user default stays exact");
  assert.equal(catalog.supportsLatestOnly, false);
  const base = manager.core.catalog.find(pin => pin.version === "1.8.0");
  assert.equal(base.upstreamRevision, revision("f"));
  assert.equal(base.publishedRelease.upstreamRevision, revision("a"));
  assert.equal(base.publishedRelease.upstreamTag, "v1.8.0");
  const cached = readRuntimeCatalog({ userDataDir, managerId: "catalog-test" });
  assert.deepEqual(cached.entries.map(pin => pin.version), ["1.8.0", "1.9.0"]);
  const restarted = make();
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, catalog.versions);
  assert.equal(restarted.resolveSelection({}, settings, userDataDir).version, "1.8.0", "The user choice survives a cold catalog load");
  assert.equal(calls, 2, "startup must read cached versions without network");
});

test("removed and replaced remote builds keep installed identities across restart without stale download options", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t), executable = path.join(userDataDir, "native");
  fs.writeFileSync(executable, binary(), { mode: 0o755 });
  let round = 0;
  const make = () => createPinnedNativeManager({ id: "installed-catalog", label: "Catalog", catalog: [entry("base", "f")],
    discoverCatalog: async () => ++round === 1 ? [entry("A", "a"), entry("B", "b")] : [entry("B", "c"), entry("C", "d")] });
  const manager = make(); await manager.refreshCatalog({ userDataDir, force: true });
  manager.core.registerLocal({ userDataDir, version: "A", runtimePath: executable });
  manager.core.registerLocal({ userDataDir, version: "B", runtimePath: executable });
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.deepEqual(manager.getState({ userDataDir }).catalog.versions, ["B", "C"]);
  assert.equal(manager.getState({ userDataDir }).catalog.installableVersions.includes("A"), false);
  const restarted = make();
  assert.equal(restarted.core.resolveInstalled({ userDataDir, version: "A" }).upstreamRevision, revision("a"));
  assert.equal(restarted.core.resolveInstalled({ userDataDir, version: "B" }).upstreamRevision, revision("b"));
  assert.equal(restarted.core.catalog.find(pin => pin.version === "B").upstreamRevision, revision("c"));
  assert.equal(restarted.getState({ userDataDir }).installed.filter(row => row.ready).length, 2);
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["B", "C"]);
  restarted.uninstallRuntime({ userDataDir, version: "A" });
  assert.deepEqual(restarted.getState({ userDataDir }).catalog.versions, ["B", "C"]);
  await assert.rejects(() => restarted.installRuntime({ userDataDir, version: "A" }), /no longer/);
});

test("historical assets without publisher digests record local hashes without claiming verified provenance", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = temporary(t);
  const manager = createPinnedNativeManager({ id: "legacy-digest", label: "Legacy", catalog: [{ ...entry("0.99.0"), asset: {
    filename: "legacy.zip", url: "https://github.com/owner/repo/releases/download/v0.99.0/legacy.zip", assetId: 123,
    integrity: "recorded-local", sha256: null } }], resolveExecutable: root => path.join(root, "engine"), dependencies: {
    downloadToFile: async (_url, output) => fs.writeFileSync(output, "old official archive"),
    extractArchive: async (_archive, directory) => fs.writeFileSync(path.join(directory, "engine"), binary(), { mode: 0o755 })
  } });
  const installed = await manager.installRuntime({ userDataDir, version: "0.99.0" });
  assert.equal(installed.provenanceVerified, false);
  assert.equal(installed.integritySource, "recorded-local");
  assert.equal(installed.archiveSha256, crypto.createHash("sha256").update("old official archive").digest("hex"));
  assert.equal(installed.assetId, 123);
});

test("installed release identities remain selectable after a catalog cache is removed or the offline base changes", { skip: process.platform !== "darwin" }, t => {
  const userDataDir = temporary(t), executable = path.join(userDataDir, "engine");
  fs.writeFileSync(executable, binary(), { mode: 0o755 });
  const original = createPinnedNativeManager({ id: "offline-identity", label: "Offline", catalog: [entry("older", "a")] });
  original.core.registerLocal({ userDataDir, version: "older", runtimePath: executable });
  const updated = createPinnedNativeManager({ id: "offline-identity", label: "Offline", catalog: [entry("newer", "b")] });
  assert.deepEqual(updated.getState({ userDataDir }).catalog.versions, []);
  assert.equal(updated.getState({ userDataDir }).installed[0].version, "older");
  const selection = updated.resolveSelection({ runtimeData: { "offline-identity": { version: "older" } } }, {}, userDataDir);
  assert.equal(selection.ready, true); assert.equal(selection.install.upstreamRevision, revision("a"));
  updated.uninstallRuntime({ userDataDir, version: "older" });
  assert.equal(fs.existsSync(executable), true);
});

test("immutable commit snapshots do not invent upstream release tags", async t => {
  const userDataDir = temporary(t);
  const manager = createPinnedNativeManager({ id: "commit-source", label: "Commit", catalog: [entry("base")],
    discoverCatalog: async () => [{ ...entry("2026-10-08-abcdef-appkit"), sourceKind: "commit" }] });
  await manager.refreshCatalog({ userDataDir, force: true });
  assert.equal(manager.core.catalog.find(pin => pin.sourceKind === "commit").upstreamTag, undefined);
});

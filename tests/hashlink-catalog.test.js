const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/hashlink/runtime/catalog");
const Module = require("../src/modules/hashlink/main");

const futureRevision = "a".repeat(40), snapshotRevision = "b".repeat(40);
const source = { header: "#define HL_VERSION 0x020001\n", code: "int max_version = 6; if( c->version <= 1 || c->version > max_version ) {}",
  sdl: "DEFINE_PRIM(_BOOL, event_loop, _DYN );", workflow: "darwin64)\n  cmake -DCMAKE_OSX_DEPLOYMENT_TARGET=10.13 \\\n  -DFLAT_INSTALL_TREE=ON\n  ;;" };
const fileNames = { "src/hl.h": "header", "src/code.c": "code", "libs/sdl/sdl.c": "sdl", ".github/workflows/build.yml": "workflow" };
function nightly(revision = snapshotRevision) {
  const filename = `hashlink-${revision.slice(0, 7)}-darwin-cmake.tar.gz`;
  return { tag_name: "latest", prerelease: true, assets: [{ id: 12, name: filename, digest: `sha256:${"b".repeat(64)}`,
    browser_download_url: `https://github.com/HaxeFoundation/hashlink/releases/download/latest/${filename}`, created_at: "2026-10-09T00:00:00Z" }] };
}
function dependencies(release, revision, extra = {}) {
  return { fetchGithubReleases: async options => { assert.equal(options.includePrerelease, true); return [release, { tag_name: "1.16", assets: [] }, { tag_name: "1.15", assets: [] }]; },
    fetchGithubTags: async () => [{ name: "latest", commit: { sha: revision } }, { name: "1.16", commit: { sha: "c".repeat(40) } }, { name: "1.15", commit: { sha: "d".repeat(40) } }], request: async url => ({ status: 200, body: Buffer.from(source[fileNames[url.split(`${revision}/`)[1]]]) }), ...extra };
}

test("HashLink shared discovery includes all stable versions and identifies its real development version", async () => {
  const entries = await Catalog.createDiscovery(dependencies(nightly(), snapshotRevision))();
  assert.deepEqual(entries.map(pin => pin.version), ["2.0.1-dev-bbbbbbbbbbbb", "1.16", "1.15"]);
  const pin = entries[0];
  assert.equal(pin.upstreamVersion, "2.0.1"); assert.equal(pin.upstreamTag, "latest"); assert.equal(pin.sourceKind, "commit");
  assert.equal(pin.architecture, "x86_64"); assert.equal(pin.requiresRosettaOnArm, true);
  assert.deepEqual(pin.supportedBytecodeVersions, [2, 3, 4, 5, 6]); assert.equal(pin.nativeAbi.sdlEventLoop, "dynamic");
  assert.equal(pin.asset.sha256, "b".repeat(64)); assert.equal(pin.asset.assetId, 12); assert.notEqual(pin.version, "latest");
});

test("a changed HashLink snapshot reads version, reader and SDL ABI from its exact source without a branch label", async () => {
  const requests = [], controller = new AbortController();
  const entries = await Catalog.createDiscovery(dependencies(nightly(futureRevision), futureRevision, {
    request: async (url, options) => {
      requests.push(url); assert.equal(options.signal, controller.signal);
      const relative = url.split(`${futureRevision}/`)[1];
      return { status: 200, body: Buffer.from(source[fileNames[relative]]) };
    }
  }))({ signal: controller.signal });
  assert.equal(requests.length, 4); assert.equal(entries[0].version, "2.0.1-dev-aaaaaaaaaaaa");
  assert.equal(entries[0].minimumMacOS, "10.13");
  assert.equal(entries[0].sourceMetadata.headerSha256, crypto.createHash("sha256").update(source.header).digest("hex"));
});

test("HashLink ignores ARM-library archives and rejects changed commit, digest and asset URLs", async () => {
  const arm = nightly(); arm.assets[0].name = "hashlink-d049add-darwin-arm64-cmake.tar.gz";
  assert.deepEqual((await Catalog.createDiscovery(dependencies(arm, snapshotRevision))()).map(pin => pin.version), ["1.16", "1.15"]);
  for (const mutate of [row => row.assets[0].digest = null, row => row.assets[0].browser_download_url = "https://example.test/runtime.tar.gz",
    row => row.assets[0].name = "hashlink-ccccccc-darwin-cmake.tar.gz", row => row.assets.push({ ...row.assets[0] })]) {
    const release = nightly(); mutate(release);
    await assert.rejects(Catalog.createDiscovery(dependencies(release, snapshotRevision))(), /identity|commit|digest/i);
  }
});

test("unknown HashLink source version contracts stay unsupported and source fetches remain bounded", async () => {
  for (const changes of [{ code: "int max_version=99;" }, { sdl: "DEFINE_PRIM(_BOOL,event_loop,_OPAQUE);" },
    { header: "#define HL_VERSION moving_branch" }, { workflow: "darwinarm64)\n -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0\n ;;" }]) {
    assert.throws(() => Catalog.parseSourceMetadata({ ...source, ...changes }), /unsupported/);
  }
  await assert.rejects(Catalog.readSourceMetadata(futureRevision, { request: async () => ({ status: 200, body: Buffer.alloc(256 * 1024 + 1) }) }), /unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Catalog.readSourceMetadata(futureRevision, { signal: controller.signal,
    request: async () => ({ status: 200, body: Buffer.from(source.header) }) }), { name: "AbortError" });
});

test("HashLink compatibility checks format and ABI without a package preference", () => {
  const bytecode = {version:5,nativeAbi:{sdlEventLoop:"typed-event"}};
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:"typed-event"}},bytecode),true);
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[6],nativeAbi:{sdlEventLoop:"typed-event"}},bytecode),false);
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:"dynamic"}},bytecode),false);
});

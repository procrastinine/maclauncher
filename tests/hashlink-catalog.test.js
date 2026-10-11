const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/hashlink/runtime/catalog");
const Module = require("../src/modules/hashlink/main");

const futureRevision = "a".repeat(40);
const source = { header: "#define HL_VERSION 0x020001\n", code: "int max_version = 6; if( c->version <= 1 || c->version > max_version ) {}",
  sdl: "DEFINE_PRIM(_BOOL, event_loop, _DYN );", workflow: "darwin64)\n  cmake -DCMAKE_OSX_DEPLOYMENT_TARGET=10.13 \\\n  -DFLAT_INSTALL_TREE=ON\n  ;;" };
const fileNames = { "src/hl.h": "header", "src/code.c": "code", "libs/sdl/sdl.c": "sdl", ".github/workflows/build.yml": "workflow" };
function nightly(revision = Catalog.SNAPSHOT_REVISION) {
  const filename = `hashlink-${revision.slice(0, 7)}-darwin-cmake.tar.gz`;
  return { tag_name: "latest", prerelease: true, assets: [{ id: 12, name: filename, digest: `sha256:${"b".repeat(64)}`,
    browser_download_url: `https://github.com/HaxeFoundation/hashlink/releases/download/latest/${filename}`, created_at: "2026-10-09T00:00:00Z" }] };
}
function dependencies(release, revision, extra = {}) {
  return { fetchGithubReleases: async options => { assert.equal(options.includePrerelease, true); return [release, { tag_name: "1.16", assets: [] }, { tag_name: "1.15", assets: [] }]; },
    fetchGithubTags: async () => [{ name: "latest", commit: { sha: revision } }, { name: "1.16", commit: { sha: "c".repeat(40) } }, { name: "1.15", commit: { sha: "d".repeat(40) } }], ...extra };
}

test("HashLink shared discovery includes all stable versions and identifies its real development version", async () => {
  const entries = await Catalog.createDiscovery(dependencies(nightly(), Catalog.SNAPSHOT_REVISION))();
  assert.deepEqual(entries.map(pin => pin.version), [Catalog.SNAPSHOT_VERSION, "1.16", "1.15"]);
  const pin = entries[0];
  assert.equal(pin.upstreamVersion, "2.0.0"); assert.equal(pin.upstreamTag, "latest"); assert.equal(pin.sourceKind, "commit");
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
  assert.deepEqual((await Catalog.createDiscovery(dependencies(arm, Catalog.SNAPSHOT_REVISION))()).map(pin => pin.version), ["1.16", "1.15"]);
  for (const mutate of [row => row.assets[0].digest = null, row => row.assets[0].browser_download_url = "https://example.test/runtime.tar.gz",
    row => row.assets[0].name = "hashlink-bbbbbbb-darwin-cmake.tar.gz", row => row.assets.push({ ...row.assets[0] })]) {
    const release = nightly(); mutate(release);
    await assert.rejects(Catalog.createDiscovery(dependencies(release, Catalog.SNAPSHOT_REVISION))(), /identity|commit|digest/i);
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

test("automatic HashLink snapshots respect native ABI, format, host and exact revision dates", () => {
  const current = Catalog.SNAPSHOT;
  const later = { ...current, version: "2.0.1-dev-aaaaaaaaaaaa", publishedAt: "2026-10-09T00:00:00Z" };
  const bytecode = { version: 6, natives: [], nativeAbi: { sdlEventLoop: "dynamic" } }, host = { hostVersion: "13.0", hostArchitecture: "arm64" };
  assert.equal(Module.__test.automaticSnapshot([current, later], bytecode, host).version, later.version);
  assert.equal(Module.__test.automaticSnapshot([current], { ...bytecode, nativeAbi: { sdlEventLoop: "typed-event" } }, host), null);
  assert.equal(Module.__test.automaticSnapshot([current], { ...bytecode, version: 7 }, host), null);
  assert.equal(Module.__test.automaticSnapshot([current], bytecode, { ...host, hostVersion: "10.12" }), null);
  assert.equal(Module.__test.automaticSnapshot([current], bytecode, { ...host, hostArchitecture: "ia32" }), null);
  assert.equal(Module.__test.automaticSnapshot([{ ...later, deprecated: true }, current], bytecode, host).version, current.version);
  const legacy = { ...bytecode, natives: [{ library: "fmt", name: "mp3_open", signature: "PBi_Xfmt_mp3_", optional: false }] };
  assert.equal(Module.__test.automaticSnapshot([current], legacy, host), null, "SDL and reader compatibility cannot override a required native signature");
  assert.equal(Module.__test.automaticSnapshot([{ ...current, upstreamRevision: "a".repeat(40) }], bytecode, host), null, "unverified new commits cannot reuse another commit's primitive profile");
});

test("automatic HashLink routing matches complete primitive sets across legacy and modern families", () => {
  const manager = Module.runtimeManagers[0], host = { hostVersion: "13.0", hostArchitecture: "arm64" };
  const catalog = manager.core.catalog, select = (natives, abi = "dynamic", version = 5, candidates = catalog) =>
    Module.__test.automaticRuntime(candidates, { version, nativeAbi: { sdlEventLoop: abi }, natives }, host)?.version || null;
  const oldMp3 = { library: "fmt", name: "mp3_open", signature: "PBi_Xfmt_mp3_", optional: false };
  const dynamicEvent = { library: "sdl", name: "event_loop", signature: "PD_b", optional: false };
  const legacy = catalog.find(pin => pin.version === "1.12-macos-v1");
  const typed = catalog.find(pin => pin.version === "1.9-macos-v2");
  const profiles = require("../src/modules/hashlink/runtime/primitive-profiles");
  const effects = Object.entries(profiles.forPin(legacy).libraries.openal.signatures)
    .filter(([name]) => !Object.hasOwn(profiles.forPin(Catalog.SNAPSHOT).libraries.openal.signatures, name))
    .map(([name, signature]) => ({ library: "openal", name, signature, optional: false }));
  assert.equal(effects.length, 60, "the older OpenAL module exposes additional effect and context primitives");
  assert.equal(select([oldMp3, dynamicEvent, ...effects]), legacy.version);
  assert.equal(select([oldMp3, dynamicEvent, ...effects], "dynamic", 6), null, "the matching primitives cannot bypass its older HLB reader");
  assert.equal(select([{ ...oldMp3, signature: "P_Xfmt_mp3_" }, dynamicEvent]), Catalog.SNAPSHOT_VERSION);
  const typedEvent = { ...dynamicEvent, signature: profiles.forPin(typed).libraries.sdl.signatures.event_loop };
  assert.equal(select([oldMp3, typedEvent], "typed-event"), typed.version);
  assert.equal(select([oldMp3, typedEvent], "dynamic"), null, "both event metadata and the exact structure signature must match");
  assert.equal(select([oldMp3, dynamicEvent, { library: "missing", name: "required", signature: "P_v", optional: false }]), null);
  assert.equal(select([oldMp3, dynamicEvent], "dynamic", 5, catalog.map(pin => pin.version === legacy.version ? { ...pin, primitiveProfileSha256: "0".repeat(64) } : pin)), null);
  assert.equal(Module.__test.automaticRuntime(catalog, { version: 5, nativeAbi: { sdlEventLoop: "dynamic" }, natives: [oldMp3, dynamicEvent] }, { ...host, hostVersion: "12.7" }), null);
});

// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Catalog = require("../src/modules/hashlink/runtime/catalog");
const Module = require("../src/modules/hashlink/main");

const repository = "HaxeFoundation/hashlink", API = `https://api.github.com/repos/${repository}/`;
const futureRevision = "a".repeat(40), snapshotRevision = "b".repeat(40);
const source = { "src/hl.h": "#define HL_VERSION 0x020001\n", "src/code.c": "int max_version = 6; if( c->version <= 1 || c->version > max_version ) {}",
  "libs/sdl/sdl.c": "DEFINE_PRIM(_BOOL, event_loop, _DYN );" };
function nightly(revision = snapshotRevision, names = [`hashlink-${revision.slice(0, 7)}-darwin-cmake.tar.gz`]) {
  return Harness.githubRelease(repository, "latest", names, { prerelease: true });
}
async function discover(release, revision, options = {}) {
  const releases = [release, Harness.githubRelease(repository, "1.16", []), Harness.githubRelease(repository, "1.15", [])];
  Harness.network.routes = { ...Harness.githubRoutes(repository, releases),
    [`${API}tags`]: [{ name: "latest", commit: { sha: revision } }, { name: "1.16", commit: { sha: "c".repeat(40) } }, { name: "1.15", commit: { sha: "d".repeat(40) } }],
    ...Object.fromEntries(Object.entries(source).map(([file, text]) => [`https://raw.githubusercontent.com/${repository}/${revision}/${file}`, text])) };
  try { return await Catalog.source.discover(options); } finally { Harness.network.routes = null; }
}

test("HashLink shared discovery includes all stable versions and identifies its real development version", async () => {
  const release = nightly(), entries = await discover(release, snapshotRevision);
  assert.deepEqual(entries.map(pin => pin.version), ["2.0.1-dev-bbbbbbbbbbbb", "1.16", "1.15"]);
  const [pin] = entries;
  assert.equal(pin.details.upstreamVersion, "2.0.1"); assert.equal(pin.details.upstreamTag, "latest"); assert.equal(pin.details.sourceKind, "commit");
  assert.equal(pin.architecture, "x64");
  assert.deepEqual(pin.details.supportedBytecodeVersions, [2, 3, 4, 5, 6]); assert.equal(pin.details.nativeAbi.sdlEventLoop, "dynamic");
  assert.equal(pin.files[0].digest.value, release.assets[0].digest.slice(7)); assert.equal(pin.files[0].id, release.assets[0].id);
  assert.match(entries[1].installReason, /source release/);
});

test("a changed HashLink snapshot reads version, reader and SDL ABI from its exact source without a branch label", async () => {
  const before = Harness.network.requests.length;
  const entries = await discover(nightly(futureRevision), futureRevision);
  const raw = Harness.network.requests.slice(before).filter(url => url.startsWith("https://raw.githubusercontent.com/"));
  assert.equal(raw.length, 3); assert.ok(raw.every(url => url.includes(`/${futureRevision}/`)));
  assert.equal(entries[0].version, "2.0.1-dev-aaaaaaaaaaaa");
  assert.equal(entries[0].details.minimumMacOS, undefined, "The package's images state the macOS requirement");
  assert.equal(entries[0].details.sourceMetadata.headerSha256, crypto.createHash("sha256").update(source["src/hl.h"]).digest("hex"));
});

test("HashLink ignores ARM-library archives and follows renamed Intel archives", async () => {
  const arm = nightly(snapshotRevision, ["hashlink-d049add-darwin-arm64-cmake.tar.gz"]);
  assert.deepEqual((await discover(arm, snapshotRevision)).map(pin => pin.version), ["1.16", "1.15"]);
  const undigested = nightly(); delete undigested.assets[0].digest;
  assert.equal((await discover(undigested, snapshotRevision))[0].files[0].digest, undefined, "A missing digest is recorded at installation");
  const renamed = nightly(snapshotRevision, ["hashlink-bbbbbbb-macos-arm64.zip", "hashlink-bbbbbbb-macos-x86_64.tar.xz"]);
  const [snapshot] = await discover(renamed, snapshotRevision);
  assert.deepEqual(snapshot.files.map(file => file.name), ["hashlink-bbbbbbb-macos-x86_64.tar.xz"]);
});

test("unknown HashLink source version contracts stay unsupported", () => {
  const parts = { header: source["src/hl.h"], code: source["src/code.c"], sdl: source["libs/sdl/sdl.c"] };
  for (const changes of [{ code: "int max_version=99;" }, { sdl: "DEFINE_PRIM(_BOOL,event_loop,_OPAQUE);" },
    { header: "#define HL_VERSION moving_branch" }]) {
    assert.throws(() => Catalog.parseSourceMetadata({ ...parts, ...changes }), /unsupported/);
  }
});

test("HashLink compatibility checks format and ABI without a package preference", () => {
  const bytecode = {version:5,nativeAbi:{sdlEventLoop:"typed-event"}};
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:"typed-event"}},bytecode),true);
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[6],nativeAbi:{sdlEventLoop:"typed-event"}},bytecode),false);
  assert.equal(Module.__test.runtimeCompatible({supportedBytecodeVersions:[5],nativeAbi:{sdlEventLoop:"dynamic"}},bytecode),false);
});

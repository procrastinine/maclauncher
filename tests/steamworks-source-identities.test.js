const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Source = require("../src/modules/shared/runtime/steamworks/source-identity");
const Steam = require("../src/modules/shared/runtime/steamworks");
const Profiles = require("../src/modules/shared/runtime/steamworks/profiles");
const Automatic = require("../src/modules/shared/runtime/steamworks/automatic");

const SHA = "a".repeat(64), REVISION = "b".repeat(40);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t, identity = { sourceKind: "owned", sourceSha256: SHA }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-source-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "offline-abi-fixture-1", directory = path.join(root, "native-runtimes/steam-api-helper", version, "universal");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  const library = path.join(directory, "libsteam_api.dylib");
  fs.writeFileSync(library, bytes, { mode: 0o644 });
  const interfaces = ["SteamClient017", "SteamUser018"];
  const manifest = { schemaVersion: 1, id: "steam-api-helper", version, ...identity,
    librarySha256: hash(bytes), qualifiedInterfaces: interfaces,
    files: [{ path: "libsteam_api.dylib", size: bytes.length, sha256: hash(bytes), mode: 0o644, architectures: ["arm64"] }] };
  const pin = { version, ...identity, librarySha256: hash(bytes), qualifiedInterfaces: interfaces, architectures: ["arm64"] };
  const declaration = { id: "steam-api-helper", version, launcherArchitectures: [process.arch],
    directoryRelative: `steam-api-helper/${version}/universal`, manifestRelative: "helper.json" };
  const declarations = [declaration];
  const sealManifest = () => {
    const content = JSON.stringify(manifest);
    fs.writeFileSync(path.join(directory, "helper.json"), content, { mode: 0o644 });
    declaration.manifestSha256 = hash(content);
  };
  sealManifest();
  return { root, directory, library, interfaces, manifest, pin, sealManifest, declarations,
    options: { resourcesRoot: root, architecture: "arm64", interfaces, catalog: [pin], declarations } };
}

test("owned source SHA-256 and existing Git revisions retain distinct identities", () => {
  assert.deepEqual(Source.sourceIdentity({ sourceKind: "owned", sourceSha256: SHA, sourceRevision: null }), { kind: "owned", sha256: SHA });
  assert.deepEqual(Source.sourceIdentity({ sourceRevision: REVISION }), { kind: "git", revision: REVISION });
  assert.equal(Source.sameSourceIdentity({ sourceKind: "git", sourceRevision: REVISION }, { sourceRevision: REVISION }), true);
  assert.equal(Source.sameSourceIdentity({ sourceKind: "owned", sourceSha256: SHA }, { sourceKind: "owned", sourceSha256: "c".repeat(64) }), false);
  for (const value of [null, {}, { sourceRevision: SHA }, { sourceKind: "owned", sourceSha256: REVISION },
    { sourceKind: "owned", sourceSha256: SHA, sourceRevision: REVISION }, { sourceRevision: REVISION, sourceSha256: SHA },
    { sourceKind: "unknown", sourceSha256: SHA }, { sourceKind: "owned", sourceSha256: SHA.toUpperCase() }]) {
    assert.equal(Source.sourceIdentity(value), null);
  }
});

test("bundled lookup selects an owned helper without relying on an upstream overlay version", t => {
  const f = fixture(t), result = Steam.resolveBundledLibrary(f.options);
  assert.equal(result.ready, true); assert.equal(Steam.resolveBundledLibrary({ ...f.options, declarations: [] }).ready, false);
  f.pin.manifestSha256 = "0".repeat(64);
  assert.equal(Steam.resolveBundledLibrary(f.options).ready, true, "The included declaration owns manifest identity");
  assert.equal(result.version, f.pin.version); assert.equal(result.libraryPath, f.library);
  assert.equal(result.sourceKind, "owned"); assert.equal(result.sourceSha256, SHA); assert.equal(result.sourceRevision, null);
  fs.writeFileSync(path.join(f.directory, "extra.dylib"), "unexpected native input");
  assert.match(Steam.resolveBundledLibrary(f.options).reason, /file inventory differs/);
});

test("owned source validation rejects source mismatches even when a manifest is resealed", t => {
  const f = fixture(t);
  f.manifest.sourceSha256 = "c".repeat(64); f.sealManifest();
  assert.match(Steam.resolveBundledLibrary(f.options).reason, /source\/version identity changed/);
  f.manifest.sourceSha256 = SHA; f.manifest.sourceRevision = REVISION; f.sealManifest();
  assert.match(Steam.resolveBundledLibrary(f.options).reason, /source\/version identity changed/);
  delete f.manifest.sourceRevision; f.manifest.sourceKind = "git"; f.sealManifest();
  assert.match(Steam.resolveBundledLibrary(f.options).reason, /source\/version identity changed/);
});

test("legacy Git-source payload identities remain valid and cannot acquire an owned-source alias", t => {
  const f = fixture(t, { sourceRevision: REVISION });
  const result = Steam.resolveBundledLibrary(f.options);
  assert.equal(result.ready, true); assert.equal(result.sourceRevision, REVISION); assert.equal(result.sourceKind, undefined);
  f.pin.sourceKind = "owned"; f.pin.sourceSha256 = SHA;
  assert.equal(Steam.resolveBundledLibrary(f.options).ready, false);
});

test("consumer profiles bind owned source, native bytes and CPU without changing old profile IDs", t => {
  const f = fixture(t), profile = { schemaVersion: 1, id: "consumer-owned-v1", helperVersion: f.pin.version,
    helperSourceKind: "owned", helperSourceSha256: SHA, helperLibrarySha256: f.pin.librarySha256,
    architectures: ["arm64"], interfaces: f.interfaces };
  const options = { id: profile.id, pin: f.pin, architecture: "arm64", requiredInterfaces: f.interfaces, profiles: [profile] };
  assert.equal(Profiles.resolveProfile(options).id, profile.id);
  for (const changes of [{ helperSourceSha256: "c".repeat(64) }, { helperSourceRevision: REVISION },
    { helperLibrarySha256: "d".repeat(64) }, { helperSourceKind: "git" }, { architectures: ["x86_64"] }]) {
    assert.throws(() => Profiles.resolveProfile({ ...options, profiles: [{ ...profile, ...changes }] }), error => error.code === "STEAM_API_PROFILE_CHANGED");
  }
  assert.throws(() => Profiles.resolveProfile({ ...options, requiredInterfaces: ["SteamUser999"] }), error => error.code === "STEAM_API_INTERFACES_UNAVAILABLE");
  assert.throws(() => Profiles.resolveProfile({ ...options, id: "old-consumer-profile" }), error => error.code === "STEAM_API_PROFILE_UNKNOWN");
});

test("automatic launch carries the exact owned source identity and preserves child-only configuration", async t => {
  const f = fixture(t), base = { PATH: "/usr/bin", SteamAppId: "999", DYLD_INSERT_LIBRARIES: "/graphics.dylib" };
  const request = { required: true, appId: 480, arch: "arm64", symbols: ["SteamAPI_Init"], interfaces: f.interfaces,
    preferOffline: true, ownedDirectory: path.join(f.root, "data/games/fixture/modules/runtime/steam") };
  const result = await Automatic.prepareAutomaticLaunch(request, { resourcesRoot: f.root, userDataDir: path.join(f.root, "data"), baseEnvironment: base },
    { catalog: [f.pin], resolveBundledLibrary: options => Steam.resolveBundledLibrary({ ...options, declarations: f.declarations }), inspectMachOExports: async () => ["SteamAPI_Init"] });
  assert.deepEqual(result.identity, { version: f.pin.version, sha256: f.pin.librarySha256, sourceRevision: null,
    sourceKind: "owned", sourceSha256: SHA, architecture: "arm64", packageVersion: f.pin.version });
  assert.equal(result.environment.SteamAppId, "480"); assert.equal(result.environment.DYLD_INSERT_LIBRARIES, "/graphics.dylib");
  assert.deepEqual(base, { PATH: "/usr/bin", SteamAppId: "999", DYLD_INSERT_LIBRARIES: "/graphics.dylib" });
  await assert.rejects(Automatic.prepareAutomaticLaunch({ ...request, symbols: ["SteamAPI_Unavailable"] },
    { resourcesRoot: f.root, userDataDir: path.join(f.root, "data"), baseEnvironment: base },
    { catalog: [f.pin], resolveBundledLibrary: options => Steam.resolveBundledLibrary({ ...options, declarations: f.declarations }), inspectMachOExports: async () => ["SteamAPI_Init"] }), error => error.code === "STEAM_API_SYMBOLS_UNAVAILABLE");
});

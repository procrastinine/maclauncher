const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Steam = require("../src/modules/shared/runtime/steamworks");
const Automatic = require("../src/modules/shared/runtime/steamworks/automatic");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "steam-default-interfaces-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "default-interface-fixture-1", directory = path.join(root, "native-runtimes/steam-api-helper", version, "universal");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  const sha256 = hash(bytes); fs.writeFileSync(path.join(directory, "libsteam_api.dylib"), bytes, { mode: 0o644 });
  const identity = { sourceKind: "owned", sourceSha256: "a".repeat(64), sourceRevision: null };
  const qualifiedInterfaces = ["SteamClient017", "SteamClient023", "SteamUser018", "SteamUser023"];
  const defaultInterfaces = ["SteamClient017", "SteamUser018"];
  const manifest = { schemaVersion: 1, id: "steam-api-helper", version, ...identity, qualifiedInterfaces, defaultInterfaces,
    librarySha256: sha256, files: [{ path: "libsteam_api.dylib", size: 32, sha256, mode: 0o644, architectures: ["arm64"] }] };
  const pin = { version, ...identity, qualifiedInterfaces, defaultInterfaces, librarySha256: sha256, architectures: ["arm64"] };
  const declaration = { id: "steam-api-helper", version, launcherArchitectures: [process.arch],
    directoryRelative: `steam-api-helper/${version}/universal`, manifestRelative: "helper.json" };
  const declarations = [declaration];
  const seal = () => { const text = JSON.stringify(manifest); fs.writeFileSync(path.join(directory, "helper.json"), text, { mode: 0o644 }); declaration.manifestSha256 = hash(text); };
  seal();
  const userDataDir = path.join(root, "data"), context = { resourcesRoot: root, userDataDir, baseEnvironment: { PATH: "/usr/bin:/bin" } };
  const request = { required: true, arch: "arm64", appId: 480, symbols: ["SteamAPI_Init", "SteamAPI_Shutdown"], preferOffline: true,
    ownedDirectory: path.join(userDataDir, "games", "one", "modules", "steam-api") };
  const dependencies = { catalog: [pin], resolveBundledLibrary: options => Steam.resolveBundledLibrary({ ...options, declarations }), inspectMachOExports: async () => request.symbols };
  return { root, manifest, pin, seal, context, request, dependencies,
    resolve: () => Steam.resolveBundledLibrary({ resourcesRoot: root, architecture: "arm64", interfaces: qualifiedInterfaces, catalog: [pin], declarations }) };
}

test("unprofiled init/shutdown selects the explicit single-client default and reuses its state", async t => {
  const value = fixture(t), first = await Automatic.prepareAutomaticLaunch(value.request, value.context, value.dependencies);
  assert.deepEqual(first.interfaces, ["SteamClient017", "SteamUser018"]);
  assert.equal(fs.readFileSync(path.join(first.settingsPath, "steam_interfaces.txt"), "utf8"), "SteamClient017\nSteamUser018\n");
  const inode = fs.lstatSync(first.aliasDirectory).ino, warm = await Automatic.prepareAutomaticLaunch(value.request, value.context, value.dependencies);
  assert.equal(warm.aliasDirectory, first.aliasDirectory); assert.equal(fs.lstatSync(warm.aliasDirectory).ino, inode);
});

test("ambiguous interface unions without a default fail before writing game state", async t => {
  const value = fixture(t); delete value.pin.defaultInterfaces; delete value.manifest.defaultInterfaces; value.seal();
  await assert.rejects(Automatic.prepareAutomaticLaunch(value.request, value.context, value.dependencies), { code: "STEAM_API_INTERFACES_AMBIGUOUS" });
  assert.equal(fs.existsSync(value.context.userDataDir), false);
});

test("trusted defaults must be sealed, listed, unique and select exactly one client", t => {
  const value = fixture(t);
  for (const defaults of [[], ["SteamUser018"], ["SteamClient017", "SteamClient023"],
    ["SteamClient017", "SteamClient017"], ["SteamClient017", "SteamUser999"], ["SteamClient017", null]]) {
    value.pin.defaultInterfaces = defaults;
    assert.equal(value.resolve().ready, false); assert.match(value.resolve().reason, /default interface versions are invalid/);
  }
  value.pin.defaultInterfaces = ["SteamClient023", "SteamUser023"];
  assert.equal(value.resolve().ready, false); assert.match(value.resolve().reason, /source\/version identity changed/);
  value.manifest.defaultInterfaces = [...value.pin.defaultInterfaces]; value.seal();
  assert.equal(value.resolve().ready, true);
  delete value.manifest.defaultInterfaces; value.seal();
  assert.equal(value.resolve().ready, false);
});

test("explicit interfaces and hash-bound profiles retain their own client selection", async t => {
  const value = fixture(t), modern = ["SteamClient023", "SteamUser023"];
  const explicit = await Automatic.prepareAutomaticLaunch({ ...value.request, interfaces: modern }, value.context, value.dependencies);
  assert.deepEqual(explicit.interfaces, modern);
  const profile = { schemaVersion: 1, id: "modern-default-fixture", helperVersion: value.pin.version,
    helperSourceKind: "owned", helperSourceSha256: value.pin.sourceSha256, helperSourceRevision: null,
    helperLibrarySha256: value.pin.librarySha256, architectures: ["arm64"], interfaces: modern };
  const selected = await Automatic.prepareAutomaticLaunch({ ...value.request, abiProfile: profile.id }, value.context,
    { ...value.dependencies, profiles: [profile] });
  assert.deepEqual(selected.interfaces, modern); assert.equal(selected.abiProfile, profile.id);
  assert.equal(fs.readFileSync(path.join(selected.settingsPath, "steam_interfaces.txt"), "utf8"), "SteamClient023\nSteamUser023\n");
});

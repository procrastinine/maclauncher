const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Sdk = require("../src/modules/shared/web/runtime/greenworks-sdk");
const Manager = require("../src/modules/shared/web/runtime/nwjs-manager");

function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function universal(marker) {
  const bytes = Buffer.alloc(8256); bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4);
  for (const [index, cpu, offset] of [[0, 0x0100000c, 4096], [1, 0x01000007, 8192]]) {
    const row = 8 + index * 20; bytes.writeUInt32BE(cpu, row); bytes.writeUInt32BE(offset, row + 8);
    bytes.writeUInt32BE(64, row + 12); bytes.writeUInt32BE(12, row + 16);
    bytes.writeUInt32LE(0xfeedfacf, offset); bytes.writeUInt32LE(cpu, offset + 4); bytes.writeUInt32LE(6, offset + 12);
    bytes.write(marker, offset + 32);
  }
  return bytes;
}
function fixture(t, flat = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-sdk-input-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "selected-native-input"), userDataDir = path.join(root, "data");
  const ticket = universal("synthetic ticket"), api = universal("synthetic API");
  // This private test catalog exercises storage and validation with inert
  // Mach-O headers. It is never registered by the production SDK 1.63 catalog.
  const pin = { ...Sdk.PIN, version: "fixture-native-sdk", bytes: ticket.length, sha256: digest(ticket),
    api: { ...Sdk.PIN.api, bytes: api.length, sha256: digest(api) } };
  const input = write(path.join(source, flat ? pin.filename : pin.sourceRelativePath), ticket);
  const apiInput = write(path.join(source, flat ? pin.api.filename : pin.api.sourceRelativePath), api);
  const signatures = [], inspected = [];
  const dependencies = { inspectExports: async (file, options) => { inspected.push([file, options.arch]);
    return path.basename(file) === pin.filename ? [...pin.symbols] : [...pin.api.symbols]; },
    verifySignature: async file => signatures.push(file) };
  return { root, source, userDataDir, pin, input, apiInput, signatures, inspected,
    import: () => Sdk.importSdk({ userDataDir, runtimeRoot: source, dependencies }, pin), dependencies };
}

test("explicit SDK import validates both roles and publishes a single shared registration without altering source", async t => {
  const f = fixture(t), before = [digest(fs.readFileSync(f.input)), digest(fs.readFileSync(f.apiInput))];
  const result = await f.import();
  assert.equal(result.version, f.pin.version); assert.equal(result.apiSha256, f.pin.api.sha256);
  assert.equal(result.sha256, f.pin.sha256); assert.equal(result.source, "explicit-local-sdk-import");
  assert.deepEqual(fs.readdirSync(result.installDir).sort(), ["libsdkencryptedappticket.dylib", "libsteam_api.dylib", "receipt.json"]);
  assert.deepEqual([digest(fs.readFileSync(f.input)), digest(fs.readFileSync(f.apiInput))], before);
  assert.deepEqual(f.inspected.map(([, architecture]) => architecture), ["arm64", "x86_64", "arm64", "x86_64"]);
  assert.equal(f.signatures.length, 4);
  const identities = [fs.statSync(result.libraryPath).ino, fs.statSync(result.apiLibraryPath).ino];
  const again = await f.import();
  assert.deepEqual([fs.statSync(again.libraryPath).ino, fs.statSync(again.apiLibraryPath).ino], identities);
  assert.deepEqual(fs.readdirSync(path.dirname(again.installDir)), [f.pin.version]);
});

test("a native-library directory is sufficient; SDK headers or command-line tools are not copied", async t => {
  const f = fixture(t, true); write(path.join(f.source, "unused", "sdk.h"), "unused SDK header");
  const result = await f.import();
  assert.deepEqual(fs.readdirSync(result.installDir).sort(), [f.pin.filename, f.pin.api.filename, "receipt.json"]);
  assert.equal(fs.existsSync(path.join(result.installDir, "unused")), false);
});

test("changed provided roles, missing exports and invalid signatures cannot create a registration", async t => {
  for (const kind of ["changed-api", "changed-ticket", "missing-export", "signature"]) {
    const f = fixture(t);
    if (kind === "changed-api") { const bytes = fs.readFileSync(f.apiInput); bytes[100] = 1; fs.writeFileSync(f.apiInput, bytes); }
    if (kind === "changed-ticket") { const bytes = fs.readFileSync(f.input); bytes[100] = 1; fs.writeFileSync(f.input, bytes); }
    if (kind === "missing-export") f.dependencies.inspectExports = async () => [];
    if (kind === "signature") f.dependencies.verifySignature = async () => { throw Error("Invalid signature"); };
    await assert.rejects(f.import()); assert.equal(fs.existsSync(f.userDataDir), false);
  }
});

test("symlinked source and output aliases are rejected while foreign files stay unchanged", async t => {
  const f = fixture(t), sourceBytes = fs.readFileSync(f.input), foreign = write(path.join(f.root, "foreign.dylib"), sourceBytes);
  fs.unlinkSync(f.input); fs.symlinkSync(foreign, f.input);
  await assert.rejects(f.import()); assert.deepEqual(fs.readFileSync(foreign), sourceBytes); assert.equal(fs.existsSync(f.userDataDir), false);
  fs.unlinkSync(f.input); write(f.input, sourceBytes);
  fs.mkdirSync(f.userDataDir);
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.userDataDir, "runtimes"));
  await assert.rejects(f.import()); assert.deepEqual(fs.readdirSync(outside), []);
});

test("warm registration revalidates bytes and an explicit reimport repairs only its owned damaged generation", async t => {
  const f = fixture(t), result = await f.import(), before = digest(fs.readFileSync(f.input));
  const bytes = fs.readFileSync(result.apiLibraryPath); bytes[100] = 1; fs.writeFileSync(result.apiLibraryPath, bytes);
  const ticketOnly = Sdk.resolveManagedTicket(f.userDataDir, f.pin);
  assert.ok(ticketOnly?.libraryPath); assert.equal(ticketOnly.apiLibraryPath, undefined); assert.ok(ticketOnly.nativeApiReason);
  const repaired = await f.import(); assert.equal(repaired.apiSha256, f.pin.api.sha256);
  assert.equal(digest(fs.readFileSync(f.input)), before);
  assert.deepEqual(fs.readdirSync(path.dirname(repaired.installDir)), [f.pin.version]);
  fs.unlinkSync(repaired.apiLibraryPath);
  const stillValidTicket = Sdk.resolveManagedTicket(f.userDataDir, f.pin);
  assert.ok(stillValidTicket?.libraryPath); assert.equal(stillValidTicket.apiLibraryPath, undefined);
  assert.ok((await f.import()).apiLibraryPath);
});

test("ticket-only input is sufficient and an optional genuine API can be added to the same shared generation", async t => {
  const f = fixture(t, true), apiBytes = fs.readFileSync(f.apiInput); fs.unlinkSync(f.apiInput);
  const ticket = await f.import();
  assert.equal(ticket.apiLibraryPath, undefined);
  assert.deepEqual(fs.readdirSync(ticket.installDir).sort(), [f.pin.filename, "receipt.json"]);
  assert.equal(f.signatures.length, 2); assert.equal(f.inspected.length, 2);
  const inode = fs.statSync(ticket.libraryPath).ino;
  assert.equal(fs.statSync((await f.import()).libraryPath).ino, inode);
  write(f.apiInput, apiBytes);
  const both = await f.import(); assert.ok(both.apiLibraryPath);
  assert.deepEqual(fs.readdirSync(path.dirname(both.installDir)), [f.pin.version]);
  assert.deepEqual(fs.readdirSync(both.installDir).sort(), [f.pin.filename, f.pin.api.filename, "receipt.json"]);
});

test("source changes during signature verification are rejected before any data directory is created", async t => {
  const f = fixture(t);
  f.dependencies.verifySignature = async file => {
    if (fs.realpathSync(file) === fs.realpathSync(f.apiInput)) { const bytes = fs.readFileSync(f.input); bytes[100] = 1; fs.writeFileSync(f.input, bytes); }
  };
  await assert.rejects(f.import()); assert.equal(fs.existsSync(f.userDataDir), false);
});

test("SDK controls expose the import action without changing NW.js or bridge defaults", t => {
  const f = fixture(t), settings = { defaultVersion: "0.117.0", greenworksDefaultVersion: "0.80.0" };
  const section = Manager.getState({ userDataDir: f.userDataDir, settings }).sections.find(section => section.id === "greenworks");
  assert.equal(section.catalog.importable, true); assert.equal(section.catalog.importLabel, "Import Steamworks SDK 1.63…");
  assert.equal(section.catalog.nativeTicket.available, false); assert.equal(section.catalog.nativeTicket.sdkVersion, "1.63");
  assert.equal(section.defaultVersion, settings.defaultVersion);
  assert.equal(Manager.updateSettingsAfterInstall(settings, { version: Sdk.PIN.version, role: "encrypted-ticket" }, { sectionId: "greenworks" }), settings);
});

test("unknown explicit SDK versions fail before reading an input or changing data", async t => {
  const f = fixture(t);
  await assert.rejects(Sdk.importSdk({ userDataDir: f.userDataDir, runtimeRoot: f.source, version: "sdk-latest", dependencies: f.dependencies }), /explicitly listed/);
  assert.equal(fs.existsSync(f.userDataDir), false); assert.deepEqual(f.inspected, []);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const Module = require("../src/modules/nitroplus/main");
const Inspect = require("../src/modules/nitroplus/inspect");
const runtimeFixture = { version: "fixture-nitroplus", revision: "a".repeat(40), npaRevision: "b".repeat(40), plugins: ["app", "audioconvert", "videoconvertscale"] };
const Manager = require("../src/modules/nitroplus/runtime/manager");
const { peFixture, versionResource } = require("./helpers/pe-fixture");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function npa(entries = [{ name: "boot.nss", text: 'chapter main {\n#SCRIPT_VERSION="2.00";\n}\n' }], { compressed = false, encrypted = false } = {}) {
  const rows = [], payloads = [], key1 = 0x5cf58a1a, key2 = 0x689e1e0c, product = Math.imul(key1, key2) >>> 0;
  const sum = (product >>> 24) + ((product >>> 16) & 255) + ((product >>> 8) & 255) + (product & 255);
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, "ascii"), size = Buffer.byteLength(entry.text || "payload"),
      payload = compressed ? zlib.deflateSync(Buffer.from(entry.text || "payload")) : Buffer.from(entry.text || "payload");
    const row = Buffer.alloc(4 + name.length + 17); row.writeUInt32LE(name.length);
    for (let i = 0; i < name.length; i++) row[4 + i] = (name[i] - 0xfc * i + sum + (index & 255) + ((index >>> 8) & 255)) & 255;
    const cursor = 4 + name.length; row[cursor] = 2;
    row.writeUInt32LE(offset, cursor + 5); row.writeUInt32LE(payload.length, cursor + 9); row.writeUInt32LE(size, cursor + 13);
    rows.push(row); payloads.push(payload); offset += payload.length;
  }
  const header = Buffer.alloc(41); Inspect.MAGIC.copy(header); header.writeInt32LE(key1, 7); header.writeInt32LE(key2, 11);
  header[15] = Number(compressed); header[16] = Number(encrypted); header.writeUInt32LE(entries.length, 17);
  header.writeUInt32LE(entries.length, 25); header.writeUInt32LE(rows.reduce((total, row) => total + row.length, 0), 37);
  return Buffer.concat([header, ...rows, ...payloads]);
}
function game(root, options = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "nss.npa"), npa(undefined, options));
  fs.writeFileSync(path.join(root, "system.npa"), npa([{ name: "system.ini", text: "[product]\nname=A Nitroplus Game\nversion=version2.00\n[script]\nstart=nss/boot.nss\n[window]\ntitle=A Nitroplus Game\nwidth=800\nheight=600\n" }]));
  fs.writeFileSync(path.join(root, "game.exe"), peFixture({ version: versionResource({ strings: { CompanyName: "Nitroplus", ProductName: "A Nitroplus Game" } }) }).bytes);
  return root;
}
function detect(root, inputPath = root) { return Module.detectGame({ rootDir: root, inputPath, isAppBundle: false }); }
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function install(root, version = runtimeFixture.version) {
  const executablePath = path.join(root, "bin/npengine-runner"), pluginRoot = path.join(root, "lib/gstreamer-1.0");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true }); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(executablePath, ["MACLAUNCHER_NPENGINE_SAVE_DIR", runtimeFixture.revision, runtimeFixture.npaRevision, "--check-scripts"].join("\0"), { mode: 0o755 });
  for (const plugin of runtimeFixture.plugins) fs.writeFileSync(path.join(pluginRoot, `libgst${plugin}.dylib`), "plugin fixture");
  fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ version, sourceTreeSha256: "a".repeat(64), overlaySha256: "b".repeat(64),
    upstreamRevision: runtimeFixture.revision, npaRevision: runtimeFixture.npaRevision, plugins: runtimeFixture.plugins }));
  fs.writeFileSync(path.join(root, "fontconfig.conf"), "font configuration fixture");
  return { version, upstreamRevision: runtimeFixture.revision, executablePath, sha256: hash(executablePath) };
}

const Backcompat = require("../src/modules/nitroplus/backcompat");

test("released v0.5.1 Nitroplus saves stay active and cwd/config bytes survive original-path preparation", t => {
  const root = fs.realpathSync(temporary(t)), original = game(path.join(root, "Original")), userDataDir = path.join(root, "profile"), runtime = install(path.join(root, "runtime"));
  const entry = { ...detect(original), gameId: "released-nitro" }, context = { userDataDir };
  const releasedDirectory = path.join(userDataDir, "games", entry.gameId, "modules", "nitroplus"), saves = path.join(releasedDirectory, "saves");
  fs.mkdirSync(saves, { recursive: true }); fs.writeFileSync(path.join(saves, "0001.npf"), "released progress");
  fs.writeFileSync(path.join(saves, "settings.ini"), "released configuration");
  fs.writeFileSync(path.join(releasedDirectory, "cwd-user-note.txt"), "unknown cwd bytes");
  fs.writeFileSync(path.join(releasedDirectory, "native.log"), "released diagnostic");
  fs.writeFileSync(path.join(original, "settings.ini"), "original configuration");
  const data = entry.moduleData, releasedPreparation = JSON.stringify({ runtimeVersion: runtime.version,
    engineRevision: runtime.upstreamRevision, npaRevision: runtimeFixture.npaRevision, originalDataRoot: path.resolve(original),
    archives: data.archives.map(archive => ({ path: path.resolve(archive.path), bytes: archive.bytes, indexBytes: archive.indexBytes })),
    bootScript: data.bootScript, saves, copies: [] }, null, 2) + "\n";
  const metadata = path.join(releasedDirectory, "preparation.json"), stamp = new Date(1000000000000);
  fs.writeFileSync(metadata, releasedPreparation); fs.utimesSync(metadata, stamp, stamp);
  const prepared = Module.__test.prepareLaunch(entry, context, runtime);
  assert.equal(prepared.cwd, original); assert.equal(prepared.directory, releasedDirectory);
  assert.equal(prepared.saves, saves, "save default is unchanged from actual v0.5.1");
  assert.equal(fs.readFileSync(metadata, "utf8"), releasedPreparation);
  assert.equal(fs.statSync(metadata).mtimeMs, stamp.getTime(), "actual released metadata schema is reused without a rewrite");
  assert.deepEqual(Backcompat.legacyGameMirrors(entry, context), [], "active saves and diagnostics are not retired");
  for (const [relative, bytes] of [["saves/0001.npf", "released progress"], ["saves/settings.ini", "released configuration"], ["cwd-user-note.txt", "unknown cwd bytes"], ["native.log", "released diagnostic"]])
    assert.equal(fs.readFileSync(path.join(releasedDirectory, relative), "utf8"), bytes);
  assert.equal(fs.readFileSync(path.join(original, "settings.ini"), "utf8"), "original configuration");
});

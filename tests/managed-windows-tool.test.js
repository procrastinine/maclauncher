const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createManagedWindowsTool, inspectWindowsTool, windowsPath, ensureWine } = require("../src/modules/shared/runtime/managed-windows-tool");

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-tool-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function pe() {
  const bytes = Buffer.alloc(1024); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt16LE(3, 220); return bytes;
}
function manager(dependencies = {}) { return createManagedWindowsTool({ id: "fixture-tool", label: "Fixture tool", owner: "publisher", repo: "tool",
  executableName: "tool.exe", assetPattern: /^tool\.exe$/, dependencies }); }

test("managed PE tools discover only on an explicit action and cancellation downloads nothing", async t => {
  const userDataDir = path.join(temporary(t), "profile"); let requests = 0;
  const tool = manager({ fetchGithubReleases: async () => { requests++; return []; } });
  assert.deepEqual(tool.getState({ userDataDir }).catalog.versions, []);
  tool.resolveSelection({}, {}, userDataDir); assert.equal(requests, 0);
  await assert.rejects(tool.ensure({}, {}, { userDataDir, settings: {}, confirmRuntimeInstall: async () => false }), { code: "ABORT_ERR" });
  assert.equal(requests, 0); assert.equal(fs.existsSync(userDataDir), false);
});

test("upstream PE download retains its pinned notice and checksum and rejects later changes", async t => {
  const userDataDir = path.join(temporary(t), "profile"), bytes = pe();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), revision = "a".repeat(40);
  const tool = manager({
    fetchGithubReleases: async () => [{ tag_name: "v1.0", html_url: "https://github.com/publisher/tool/releases/tag/v1.0",
      assets: [{ name: "tool.exe", size: bytes.length, id: 123, digest: "sha256:" + sha256, browser_download_url: "https://github.com/publisher/tool/releases/download/v1.0/tool.exe" }] }],
    fetchGithubTags: async () => [{ name: "v1.0", commit: { sha: revision } }],
    downloadToFile: async (url, file) => {
      if (url.endsWith("/LICENSE")) { assert.equal(url, `https://raw.githubusercontent.com/publisher/tool/${revision}/LICENSE`); fs.writeFileSync(file, "MIT License"); }
      else fs.writeFileSync(file, bytes);
    }
  });
  const context = { userDataDir, settings: {}, confirmRuntimeInstall: async () => true };
  const install = await tool.ensure({}, {}, context);
  assert.equal(install.version, "1.0"); assert.equal(install.upstreamRevision, revision);
  assert.equal(fs.readFileSync(path.join(install.installDir, "LICENSE"), "utf8"), "MIT License");
  assert.equal(tool.resolveSelection({}, {}, userDataDir).ready, true);
  const changed = Buffer.from(bytes); changed[800] ^= 1; fs.writeFileSync(install.executablePath, changed);
  assert.equal(tool.resolveSelection({}, {}, userDataDir).ready, false);
});

test("PE tool inspection rejects DLLs, aliases and invalid checksums", t => {
  const root = temporary(t), file = path.join(root, "tool.exe"), bytes = pe(); fs.writeFileSync(file, bytes);
  assert.deepEqual(inspectWindowsTool({ runtimePath: file }).architectures, ["x86_64"]);
  assert.throws(() => inspectWindowsTool({ runtimePath: file, expectedSha256: "a".repeat(64) }), /changed/);
  const alias = path.join(root, "alias.exe"); fs.symlinkSync(file, alias); assert.throws(() => inspectWindowsTool({ runtimePath: alias }), /executable/);
  bytes.writeUInt16LE(0x2002, 150); fs.writeFileSync(file, bytes); assert.throws(() => inspectWindowsTool({ runtimePath: file }), /executable/);
});

test("Windows path conversion preserves spaces and Unicode while rejecting filename operators", () => {
  assert.equal(windowsPath("/game folder/日本語/file.ain"), "Z:\\game folder\\日本語\\file.ain");
  assert.throws(() => windowsPath("relative/file.ain"), /absolute/);
  assert.throws(() => windowsPath('/game/quote".ain'), /paths/);
});

test("missing Wine host is consented before runtime discovery or acquisition", async t => {
  const userDataDir = temporary(t); let discovered = false;
  const sikarugir = { id: "sikarugir", label: "Wine", resolveSelection: () => ({ ready: false, version: "known" }),
    resolveForPlay: async () => { discovered = true; } };
  const crossover = { resolveSelection: () => ({ ready: false }) };
  await assert.rejects(ensureWine({}, { userDataDir, settings: {}, confirmRuntimeInstall: async () => false }, { sikarugir, crossover }), { code: "ABORT_ERR" });
  assert.equal(discovered, false);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Runtime = require("../src/modules/shared/onsyuri/runtime/onsyuri-runtime");

test("getWebArchiveType identifies supported web archives", () => {
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri_web.7z"), "7z");
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri-web.zip"), "zip");
  assert.equal(Runtime.__test.getWebArchiveType("ONSYURI_WEB.ZIP"), "zip");
  assert.equal(Runtime.__test.getWebArchiveType("onsyuri_web.tar.gz"), null);
});

test("Mac build normalization remains separate from the legacy Web release mapping", () => {
  const version = "0.7.7beta-macos-v2";
  assert.equal(Runtime.normalizeMacVersion(version), version);
  assert.equal(Runtime.normalizeVersion(version), "0.7.7beta");
});

test("unavailable portable versions never fall back to a stock Mac release or mutate installations", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-yuri-missing-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  t.mock.method(Runtime.bundled, "install", async () => null);
  await assert.rejects(Runtime.installMacVersion({ userDataDir, version: "0.7.7beta-macos-v2", variant: "arm64", releases: [{ tag_name: "v0.7.7beta", assets: [{ name: "onsyuri_v0.7.7beta_aarch64_darwin", browser_download_url: "https://example.invalid/stock" }] }] }), /unavailable for this app and architecture/);
  assert.equal(fs.existsSync(path.join(userDataDir, "runtimes")), false);
});

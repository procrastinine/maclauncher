const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const File = require("../src/modules/shared/runtime/pinned-file");
const Font = require("../src/modules/nscripter/font");
const { resolveFontPath } = require("../src/modules/nscripter/main").__test;

test("NScripter fallback is shared, offline to resolve, and skipped for game or configured fonts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nscripter-font-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared.ttf"), custom = path.join(root, "custom.ttf"), own = path.join(root, "default.ttf");
  for (const file of [shared, custom]) fs.writeFileSync(file, "font");
  let requests = 0;
  t.mock.method(File, "ensure", async (asset, context) => { requests++; assert.equal(asset, Font.asset); assert.equal(context.userDataDir, root); return shared; });
  t.mock.method(File, "resolve", () => shared);
  const context = { userDataDir: root, moduleSettings: {} };
  assert.equal(Font.asset.bytes, 4557928); assert.match(Font.asset.url, /^https:\/\//);
  assert.equal(resolveFontPath({ rootDir: root, userDataDir: root }), shared); assert.equal(requests, 0);
  assert.equal(await Font.ensure(root, context), shared); assert.equal(requests, 1);
  fs.writeFileSync(own, "own");
  assert.equal(await Font.ensure(root, context), null);
  assert.equal(resolveFontPath({ rootDir: root, userDataDir: root }), own);
  fs.unlinkSync(own); context.moduleSettings.defaultFontPath = custom;
  assert.equal(await Font.ensure(root, context), null);
  assert.equal(resolveFontPath({ rootDir: root, userDataDir: root, moduleSettings: context.moduleSettings }), custom);
  assert.equal(requests, 1);
});

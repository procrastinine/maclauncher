const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { vendorIdentifier } = require("../src/modules/ios/identity");
test("iOS vendor identifiers persist per game and never follow external links", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first"), second = path.join(root, "second"); fs.mkdirSync(first); fs.mkdirSync(second);
  const id = vendorIdentifier(first);
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(vendorIdentifier(first), id); assert.notEqual(vendorIdentifier(second), id);
  const file = path.join(first, "data/vendor-identifier"), outside = path.join(root, "external");
  fs.writeFileSync(outside, id + "\n"); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.notEqual(vendorIdentifier(first), id); assert.equal(fs.readFileSync(outside, "utf8"), id + "\n");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test("native iOS adapter supplies only a missing vendor UUID", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-identity-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = require("node:child_process"), executable = path.join(root, "probe");
  execFileSync("/usr/bin/xcrun", ["clang", "-fobjc-arc", "-framework", "Foundation",
    path.join(__dirname, "fixtures/ios-device-identity.m"), "-o", executable], { timeout: 30000, stdio: "pipe" });
  const helper = require("../src/modules/ios/runtime/storage-helper").resolveStorageHelper();
  for (const value of ["ABCDEF12-3456-4789-ABCD-0123456789AB", "invalid", "missing"])
    assert.match(execFileSync(executable, [helper, value], { encoding: "utf8", timeout: 10000 }), /preservation passed/);
});

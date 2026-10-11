const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const Modules = require("../src/modules/registry");

test("every registered game type declares a bundled, valid, recorded base icon", () => {
  const manifests = Modules.listModules();
  assert.ok(manifests.length >= 21);
  for (const manifest of manifests) {
    assert.equal(manifest.icon?.path, "resources/icon.png", `${manifest.id}: declare the module's base icon`);
    const directory = Modules.getModuleDir(manifest.id), image = fs.readFileSync(path.join(directory, manifest.icon.path));
    const record = JSON.parse(fs.readFileSync(path.join(directory, "resources", "icon.json"), "utf8"));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${manifest.id}: PNG signature`);
    assert.equal(image.subarray(12, 16).toString(), "IHDR", `${manifest.id}: PNG header`);
    for (const size of [image.readUInt32BE(16), image.readUInt32BE(20)]) assert.ok(size >= 32 && size <= 1024, `${manifest.id}: useful bounded dimensions`);
    assert.ok(image.length < 1024 * 1024, `${manifest.id}: bounded bundled image`);
    assert.equal(record.sha256, crypto.createHash("sha256").update(image).digest("hex"), `${manifest.id}: exact artwork identity`);
    assert.equal(record.kind, manifest.icon.kind);
    assert.ok(record.source && record.license, `${manifest.id}: attribution accompanies the image`);
  }
});

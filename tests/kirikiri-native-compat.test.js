const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Compat = require("../src/modules/kirikiri/native-compat");
const Native = require("../src/modules/shared/runtime/local-native");

test("KiriKiri native bridges require the exact pin and record every staged source/resource digest", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiri-native-compat-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "external/krkrz/base"); fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "StorageIntf.cpp"), "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/getFileProperty) { }\n");
  fs.writeFileSync(path.join(base, "SystemIntf.cpp"), "TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/terminate) { }\n");
  const before = ["StorageIntf.cpp", "SystemIntf.cpp"].map(file => Native.hashFile(path.join(base, file)));
  assert.throws(() => Compat.prepareSource({ sourceRoot: root, revision: "f".repeat(40) }), /exact reviewed/);
  const record = Compat.prepareSource({ sourceRoot: root, revision: Compat.REVISION });
  assert.equal(record.revision, "macos-storage-font-monitor-v1"); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.equal(record.files.length, 2);
  record.files.forEach((file, i) => {
    assert.equal(file.beforeSha256, before[i]); assert.equal(file.afterSha256, Native.hashFile(path.join(root, file.file)));
    assert.match(file.implementationSha256, /^[a-f0-9]{64}$/);
  });
  assert.match(fs.readFileSync(path.join(base, "StorageIntf.cpp"), "utf8"), /opendir\(native\.c_str\(\)\)/);
  assert.match(fs.readFileSync(path.join(base, "SystemIntf.cpp"), "utf8"), /AddExtraFont/);
  assert.match(fs.readFileSync(path.join(base, "SystemIntf.cpp"), "utf8"), /SDL_GetDisplayUsableBounds/);
  fs.writeFileSync(path.join(base, "StorageIntf.cpp"), "different native source");
  assert.throws(() => Compat.prepareSource({ sourceRoot: root, revision: Compat.REVISION }), /source anchor/);
});

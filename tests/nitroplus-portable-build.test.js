const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Media = require("../src/modules/nitroplus/runtime/portable-media");
const Portable = require("../src/modules/nitroplus/runtime/portable-build");
const Source = require("../src/modules/shared/runtime/pinned-native-build");
const Existing = require("../src/modules/nitroplus/runtime/build");

test("Nitroplus portable SDK binds files and contained library aliases without accepting extra modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-sdk-check-"));
  try {
    fs.mkdirSync(path.join(root, "lib"));
    const bytes = Buffer.from("pinned library bytes");
    fs.writeFileSync(path.join(root, "lib/native.1.dylib"), bytes);
    fs.symlinkSync("native.1.dylib", path.join(root, "lib/native.dylib"));
    const catalog = { schemaVersion: 1, version: Media.PIN.version,
      requiredFiles: [{ file: "lib/native.1.dylib", bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }],
      aliases: [{ file: "lib/native.dylib", target: "native.1.dylib" }] };
    assert.equal(Media.validateSDKPrefix(root, { catalog }).version, Media.PIN.version);
    fs.writeFileSync(path.join(root, "lib/extra.dylib"), "unlisted plugin");
    assert.throws(() => Media.validateSDKPrefix(root, { catalog }), /unlisted/);
    fs.rmSync(path.join(root, "lib/extra.dylib"));
    fs.writeFileSync(path.join(root, "lib/native.1.dylib"), "different library");
    assert.throws(() => Media.validateSDKPrefix(root, { catalog }), /checksum/);
    fs.writeFileSync(path.join(root, "lib/native.1.dylib"), bytes);
    fs.rmSync(path.join(root, "lib/native.dylib"));
    fs.symlinkSync("../../elsewhere", path.join(root, "lib/native.dylib"));
    assert.throws(() => Media.validateSDKPrefix(root, { catalog }), /alias changed/);
    assert.throws(() => Media.validateSDKPrefix(root, { catalog: { ...catalog, aliases: [{ file: "lib/native.dylib", target: "../../elsewhere" }] } }), /metadata/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Nitroplus V8 source export keeps NSS compatibility while replacing Homebrew library discovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-portable-source-"));
  try {
    const [engine, npa] = await Promise.all([Source.validatePinnedSource(Existing.sourcePath, Existing.REVISION), Source.validatePinnedSource(Existing.npaSourcePath, Existing.NPA_REVISION)]);
    assert.equal(Source.stagePinnedFiles(Existing.sourcePath, engine.files, path.join(root, "libnpengine")), Portable.ENGINE_TREE_SHA256);
    assert.equal(Source.stagePinnedFiles(Existing.npaSourcePath, npa.files, path.join(root, "libnpa")), Portable.NPA_TREE_SHA256);
    const overlay = Portable.adaptSource(root);
    const cmake = fs.readFileSync(path.join(root, "CMakeLists.txt"), "utf8");
    assert.doesNotMatch(cmake, /\/opt\/homebrew|\/usr\/local/);
    assert.match(cmake, /MACLAUNCHER_NATIVE_RPATHS/);
    assert.match(fs.readFileSync(path.join(root, "main.cpp"), "utf8"), /libnpengine 0\.5\.3 Mac v8 \/ da1a175/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, "main.cpp"), "utf8"), /reviewed native profile/);
    const lexer = fs.readFileSync(path.join(root, "libnpa/src/lexer.l"), "utf8");
    assert.match(lexer, /PRE_TEXT/);
    assert.match(fs.readFileSync(path.join(root, "libnpengine/include/choice-state.hpp"), "utf8"), /Mouse|Choice/);
    assert(overlay.files.some(file => file.file === "libnpa/src/lexer.l" && file.originalSha256));
    assert(overlay.files.some(file => file.file === "libnpengine/include/choice-state.hpp" && file.originalSha256 === null));
    assert.throws(() => Portable.adaptSource(root), /already contains/);
    await Promise.all([Source.validatePinnedSource(Existing.sourcePath, Existing.REVISION), Source.validatePinnedSource(Existing.npaSourcePath, Existing.NPA_REVISION)]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Nitroplus build environment removes runtime search overrides and inherited plugin paths", () => {
  const before = { fallback: process.env.DYLD_FALLBACK_LIBRARY_PATH, plugin: process.env.GST_PLUGIN_PATH_1_0 };
  try {
    process.env.DYLD_FALLBACK_LIBRARY_PATH = "/opt/homebrew/lib";
    process.env.GST_PLUGIN_PATH_1_0 = "/opt/homebrew/plugins";
    const env = Media.buildEnvironment("/private/tmp/native-prefix", "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk");
    assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
    assert.equal(env.GST_PLUGIN_PATH_1_0, undefined);
    assert.equal(env.PKG_CONFIG_PATH, "");
    assert.equal(env.MACOSX_DEPLOYMENT_TARGET, "13.0");
  } finally {
    for (const [name, value] of [["DYLD_FALLBACK_LIBRARY_PATH", before.fallback], ["GST_PLUGIN_PATH_1_0", before.plugin]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

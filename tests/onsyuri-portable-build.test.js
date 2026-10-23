const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Build = require("../src/modules/shared/onsyuri/runtime/portable-build");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-yuri-build-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Yuri adapters reject source checkouts and unexpected CMake bytes without changing them", t => {
  const root = temporary(t), checkout = path.join(root, "original"), output = path.join(root, "staged");
  fs.mkdirSync(checkout); fs.mkdirSync(output);
  fs.writeFileSync(path.join(checkout, "CMakeLists.txt"), "original");
  fs.writeFileSync(path.join(output, "CMakeLists.txt"), "unexpected");
  assert.throws(() => Build.requireOwnedSource(checkout, checkout), /cannot change source checkouts/);
  fs.mkdirSync(path.join(output, ".git"));
  assert.throws(() => Build.adaptEngine(output, checkout), /separate disposable source/);
  fs.rmSync(path.join(output, ".git"), { recursive: true });
  assert.throws(() => Build.adaptEngine(output, checkout), /differs from its pinned version/);
  assert.equal(fs.readFileSync(path.join(checkout, "CMakeLists.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(output, "CMakeLists.txt"), "utf8"), "unexpected");
});

test("Lua adaptation requires its exact ABI profile and cannot overwrite an existing build file", t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, "src"));
  const header = path.join(root, "src/lua.h");
  fs.writeFileSync(header, '#define LUA_VERSION_RELEASE\t"8"\n#define LUA_VERSION_MINOR\t"4"\n');
  assert.throws(() => Build.adaptLua(root), /selected 5\.4\.9 profile/);
  assert.equal(fs.existsSync(path.join(root, "CMakeLists.txt")), false);
  fs.writeFileSync(header, '#define LUA_VERSION_RELEASE\t"9"\n#define LUA_VERSION_MINOR\t"4"\n');
  const result = Build.adaptLua(root);
  assert.equal(result.files[0].sourceSha256, null);
  const cmake = fs.readFileSync(path.join(root, "CMakeLists.txt"));
  assert.throws(() => Build.adaptLua(root), /selected 5\.4\.9 profile/);
  assert.deepEqual(fs.readFileSync(path.join(root, "CMakeLists.txt")), cmake);
});

test("Yuri rejects dynamically resolved codecs and the excluded optional GLES renderer", t => {
  const root = temporary(t);
  for (const name of ["sdl2_image", "onsyuri"]) fs.mkdirSync(path.join(root, name));
  const image = path.join(root, "sdl2_image/compile_commands.json"), engine = path.join(root, "onsyuri/compile_commands.json");
  const imageCommands = "LOAD_PNG LOAD_JPG LOAD_WEBP", engineCommands = "USE_LUA USE_BUILTIN_LAYER_EFFECTS ENABLE_1BYTE_CHAR USE_PARALLEL";
  fs.writeFileSync(image, JSON.stringify([imageCommands])); fs.writeFileSync(engine, JSON.stringify([engineCommands]));
  const profile = Build.validateFeatures(root);
  assert.equal(profile.renderer, "SDL automatic"); assert.equal(profile.glesSharpness, false); assert.equal(profile.moviePlayback, false);
  fs.writeFileSync(image, JSON.stringify([imageCommands + " LOAD_WEBP_DYNAMIC"]));
  assert.throws(() => Build.validateFeatures(root), /unselected dynamic codec/);
  fs.writeFileSync(image, JSON.stringify([imageCommands]));
  for (const forbidden of ["USE_GLES", "renderer/gles_renderer.cpp"]) {
    fs.writeFileSync(engine, JSON.stringify([engineCommands + " " + forbidden]));
    assert.throws(() => Build.validateFeatures(root), /excluded GLES sharpness/);
  }
});

test("cancelled Yuri builds and invalid primary archives fail before producing build output", async t => {
  const root = temporary(t), workRoot = path.join(root, "output"), archive = path.join(root, "source.tar.gz");
  fs.writeFileSync(archive, "wrong");
  assert.throws(() => Build.validateEngineArchive({ onsyuri: archive }), /checksum or size/);
  await assert.rejects(Build.buildPortableYuri({ workRoot, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(fs.existsSync(workRoot), false); assert.equal(fs.readFileSync(archive, "utf8"), "wrong");
});

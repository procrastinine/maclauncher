const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const ReShade = require("../src/modules/shared/reshade"), Requirements = require("../src/modules/shared/effects/execution-requirements"), Verify = require("../src/modules/shared/reshade/payload-verification");
test("component requirements are pure and independent features do not request unrelated providers", () => {
  assert.ok(Requirements.analyze().components.every(row => !row.needed && row.reason === null));
  const crt = Requirements.analyze({reshade: {enabled: true, preset: "crt"}}).needed;
  assert.equal(crt.shaders, true);assert.equal(crt.processor, true);
  for (const field of ["spatial", "temporal", "neural", "generation", "sourceResolution", "virtualWindow", "losslessModel", "fsr", "fsr4", "presentation"]) assert.equal(crt[field], false, field);
  const scaling = Requirements.analyze({graphics: {spatialMethod: "ls1", spatialMultiplier: 2}}, {sourceSupport: {control: "virtual"}});
  for (const field of ["processor", "spatial", "sourceResolution", "virtualWindow", "losslessModel", "presentation"]) assert.equal(scaling.needed[field], true, field);
  assert.equal(scaling.needed.neural, false);assert.equal(scaling.needed.fsr, false);
  assert.equal(Requirements.analyze({graphics: {spatialMethod: "bilinear", spatialMultiplier: 1}}, {sourceSupport: {control: "virtual"}}).needed.virtualWindow, false);
});
test("disabled graphics skip runtime discovery, preparation and per-game state on every host", async t => {
  const Native = require("../src/modules/shared/runtime/bundled-native"), Filters = require("../src/modules/shared/reshade/filter-library"), Neural = require("../src/modules/shared/reshade/neural");
  t.mock.method(Native, "systemVersionSync", () => assert.fail("no runtime discovery"));
  t.mock.method(Filters, "list", () => assert.fail("no shader catalog"));
  t.mock.method(Neural, "resolve", () => assert.fail("no neural provider"));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-off-")), profile = path.join(temporary, "not-created");
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  const entries = [{}, {graphics: {spatialMethod: "off", neuralMethod: "off", frameGeneration: "off", temporalMethod: "off", modelVersion: "sha256-" + "a".repeat(64)}},
    {effects: {schema: 1, mode: "advanced", video: [{id: "disabled", kind: "neural", method: "mlx-dlss", enabled: false, settings: {}}]}}];
  for (const graphicsHost of ["window", "explicit", "remote", "catalyst", null]) for (const entry of entries)
    assert.deepEqual(await ReShade.prepare(entry, {root: "/unreadable", userDataDir: profile, graphicsHost,
      verify: () => assert.fail("no payload reads"), execute: () => assert.fail("no compiler")}), {});
  assert.equal(fs.existsSync(profile), false);
});
test("launch verification checks only requested components and invalidates changed file identities", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "graphics-verify-")));
  t.after(() => {Verify.clear();fs.rmSync(root, {recursive: true, force: true});});
  const make = name => {fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});fs.writeFileSync(path.join(root, name), "original");return {path: name, size: 8, mode: 0o644, sha256: crypto.createHash("sha256").update("original").digest("hex")};};
  const manifest = {files: [make("runtime.json"), make("libreshade-macos.dylib"), make("libvkd3d-shader.dylib"), make("fx-compile"), make("effects/crt.fx"), make("neural/unused.dylib"), make("temporal/fsr4/unused.bin")]};
  fs.unlinkSync(path.join(root, "neural/unused.dylib"));fs.unlinkSync(path.join(root, "temporal/fsr4/unused.bin"));
  const entry = {reshade: {enabled: true, preset: "crt"}}, options = {manifest};
  assert.equal(Verify.verifyLaunch(root, {}, options).files, 0);
  assert.equal(Verify.verifyLaunch(root, {}, {...options, activation: true}).files, 3,
    "dormant injection verifies its core closure without inspecting optional providers");
  assert.equal(Verify.verifyLaunch(root, entry, options).files, 5);
  assert.equal(Verify.verifyLaunch(root, entry, options).files, 5);
  fs.writeFileSync(path.join(root, "effects/crt.fx"), "modified");
  assert.throws(() => Verify.verifyLaunch(root, entry, options), /checksum/);
});

test("new launches see atomic graphics publications while admitted roots retain their exact verification snapshot", t => {
  const Publication = require("../src/modules/shared/reshade/publication");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-publication-"));
  t.after(() => {Verify.clear();fs.rmSync(temporary, {recursive: true, force: true});});
  const declaration = path.join(temporary, "selected.json"), resources = path.join(temporary, "resources");
  const warnings = [];
  const reader = Publication.createReader(declaration, {warn: (...args) => {warnings.push(args);throw new Error("warning sink unavailable");}});
  const writeDeclaration = value => {
    fs.writeFileSync(declaration + ".next", value);fs.renameSync(declaration + ".next", declaration);
  };
  function publish(version) {
    const directoryRelative = `reshade/${version}/universal`, root = path.join(resources, "native-runtimes", directoryRelative);
    fs.mkdirSync(root, {recursive: true});
    const files = ["runtime.json", "libreshade-macos.dylib", "libvkd3d-shader.dylib"].map(name => {
      const bytes = name === "runtime.json" ? JSON.stringify({schema: 1, version, minimumMacOS: "13.0"}) : version;
      fs.writeFileSync(path.join(root, name), bytes);
      return {path: name, size: Buffer.byteLength(bytes), sha256: crypto.createHash("sha256").update(bytes).digest("hex")};
    });
    const manifest = {id: "reshade", version, directoryRelative, manifestRelative: "runtime.json", manifestSha256: files[0].sha256, files};
    writeDeclaration(JSON.stringify([manifest]));return root;
  }
  let declarationReads = 0;
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === declaration) declarationReads++;
    return readFile(file, ...args);
  });
  t.mock.method(Publication, "resolveRoot", () => reader.resolveRoot([resources]));
  t.mock.method(Publication, "forRoot", reader.forRoot);
  const first = publish("first"), options = {presenter: true};
  assert.equal(ReShade.runtimeRoot(), first);
  assert.equal(Verify.verifyLaunch(first, {}, options).files, 3);
  const acceptedFirst = reader.forRoot(first);
  const alias = path.join(temporary, "first-alias");fs.symlinkSync(first, alias);
  assert.equal(reader.forRoot(alias), acceptedFirst);
  assert.equal(ReShade.runtimeRoot(), first);assert.equal(declarationReads, 1, "warm resolution does not reparse the declaration");
  const second = publish("second");
  assert.equal(ReShade.runtimeRoot(), second);assert.equal(declarationReads, 2);
  assert.equal(Verify.verifyLaunch(second, {}, options).files, 3);
  assert.equal(Verify.verifyLaunch(first, {}, options).files, 3, "old bytes are checked against the old admitted manifest");
  assert.equal(reader.forRoot(first), acceptedFirst);
  assert.equal(reader.forRoot(alias), acceptedFirst, "canonical and alias paths retain the same admitted generation");
  writeDeclaration('{"incomplete":');
  assert.equal(ReShade.runtimeRoot(), second, "an invalid new declaration retains the last valid publication");
  assert.equal(ReShade.runtimeRoot(), second);assert.equal(warnings.length, 1, "unchanged invalid declarations warn once even with a failing observer");
  fs.unlinkSync(declaration);
  assert.equal(ReShade.runtimeRoot(), second, "a transient stat failure retains the last valid publication");
  assert.equal(ReShade.runtimeRoot(), second);assert.equal(warnings.length, 2, "unchanged stat failures warn once");
  assert.throws(() => Publication.createReader(declaration).current(), /ENOENT/);
});

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Dmg = require("../src/modules/shared/runtime/dmg");
const Component = require("../src/modules/shared/runtime/component-runtime");
const Description = require("../src/modules/shared/runtime/translator-description");
const { image, X64 } = require("./fixtures/macho-image");

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "translator-disk-image-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
// A UDIF image ends in a 512-byte koly trailer that locates its property-list
// resources; an agreement is stored there as an LPic resource.
function udif(file, resources) {
  const data = Buffer.alloc(1024, 7), xml = Buffer.from(`<plist><dict><key>resource-fork</key><dict>${resources}</dict></dict></plist>`);
  const trailer = Buffer.alloc(512); trailer.write("koly", 0, "latin1");
  trailer.writeBigUInt64BE(BigInt(data.length), 216); trailer.writeBigUInt64BE(BigInt(xml.length), 224);
  write(file, Buffer.concat([data, xml, trailer]));
}
function frameworkVolume(volume, version) {
  const framework = path.join(volume, "redist/lib/external/D3DMetal.framework");
  write(path.join(framework, "Versions/A/D3DMetal"), image({ cpu: X64, fileType: 6, installName: "@rpath/D3DMetal.framework/Versions/A/D3DMetal" }));
  write(path.join(framework, "Versions/A/Resources/version.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  fs.symlinkSync("A", path.join(framework, "Versions/Current"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
  fs.symlinkSync("Versions/Current/D3DMetal", path.join(framework, "D3DMetal"));
  write(path.join(volume, "License.rtf"), "licence");
}

test("disk images with a licence agreement attach with hdiutil, others with diskutil first", async t => {
  const root = scratch(t), licensed = path.join(root, "licensed.dmg"), plain = path.join(root, "plain.dmg");
  udif(licensed, "<key>LPic</key><array/><key>plst</key><array/>"); udif(plain, "<key>plst</key><array/>");
  assert.equal(Dmg.hasLicenceAgreement(licensed), true);
  assert.equal(Dmg.hasLicenceAgreement(plain), false);
  write(path.join(root, "short.dmg"), "koly"); assert.equal(Dmg.hasLicenceAgreement(path.join(root, "short.dmg")), false);
  for (const [file, tools] of [[licensed, ["hdiutil attach", "hdiutil detach"]], [plain, ["diskutil image", "diskutil eject"]]]) {
    const calls = [];
    const run = async (command, args) => { calls.push(`${path.basename(command)} ${args[0]}`); };
    assert.equal(await Dmg.withMountedDmg(file, undefined, { run }, async volume => fs.statSync(volume).isDirectory()), true);
    assert.deepEqual(calls, tools);
  }
});

test("a distribution disk image imports only the nested image that holds the component", async t => {
  const root = scratch(t), userDataDir = path.join(root, "profile"), outer = path.join(root, "volumes/outer"), inner = path.join(root, "volumes/inner");
  const toolkit = path.join(root, "Game_Porting_Toolkit.dmg");
  write(toolkit, "outer image bytes");
  write(path.join(outer, "Evaluation environment.dmg"), "inner image bytes");
  write(path.join(outer, "Guide.pdf"), "pdf"); write(path.join(outer, "gptk-sample/sample.cpp"), "sample");
  frameworkVolume(inner, "4.0b3");
  const volumes = new Map([[toolkit, outer], [path.join(outer, "Evaluation environment.dmg"), inner]]), attached = [];
  t.mock.method(Dmg, "withMountedDmg", async (file, _signal, _options, use) => { attached.push(path.basename(file)); return use(volumes.get(file)); });
  const names = ["d3dmetal", "apple_gptk", "redist"];
  const { root: imported } = await Component.prepareArchive(toolkit, { userDataDir, names });
  assert.deepEqual(attached, ["Game_Porting_Toolkit.dmg", "Evaluation environment.dmg"]);
  assert.deepEqual(fs.readdirSync(imported).sort(), ["License.rtf", "redist"], "samples and guides stay in the supplied image");
  assert.equal(path.dirname(imported), path.join(userDataDir, "runtimes/imports"));
  assert.equal(Component.componentRoot(imported, { names }), path.join(imported, "redist"));
  // A volume that already holds the component is imported whole.
  attached.length = 0;
  const evaluation = path.join(root, "evaluation.dmg"); write(evaluation, "evaluation bytes"); volumes.set(evaluation, inner);
  const direct = (await Component.prepareArchive(evaluation, { userDataDir, names })).root;
  assert.deepEqual(attached, ["evaluation.dmg"]);
  assert.deepEqual(fs.readdirSync(direct).sort(), ["License.rtf", "redist"]);
});

test("a component without version text takes the version of the framework named after its engine", t => {
  const root = scratch(t), volume = path.join(root, "volume");
  frameworkVolume(volume, "4.0b3");
  const description = Description.describeTranslator(path.join(volume, "redist"), { engine: "d3dmetal", source: "custom" });
  assert.equal(description.version, "4.0b3");
  write(path.join(volume, "redist/version"), "custom label");
  assert.equal(Description.describeTranslator(path.join(volume, "redist"), { engine: "d3dmetal", source: "custom" }).version, "custom label",
    "a component's own version text stays first");
  assert.equal(Description.describeTranslator(path.join(volume, "redist/lib/external"), { engine: "dxmt", source: "custom" }).version, "",
    "a framework named after another engine does not version the component");
});

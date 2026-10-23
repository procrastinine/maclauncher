const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Inputs = require("../src/modules/shared/runtime/native-graphics-inputs");
test("Native graphics reuses Intel, ARM and universal executable metadata", () => {
  const inspect = () => assert.fail("Recorded executable metadata avoids filesystem inspection");
  for (const [architectures, host, expected] of [[["x86_64"], "arm64", "x86_64"], [["arm64"], "x64", "arm64"],
    [["x86_64", "arm64"], "arm64", "arm64"], [["arm64", "x86_64"], "x64", "x86_64"]]) {
    assert.equal(Inputs.resolveArchitecture({moduleData: {executableArchitectures: architectures}},
      {runtimeId: "native", hostArchitecture: host, readArchitectures: inspect}), expected);
  }
});
test("Native graphics preserves engine source contracts and authoritative declarations", () => {
  const graphicsInputs = {architecture: "x64", cameraProjection: true, sourceResolution: false, opacity: false, methods: ["fsr2"]};
  assert.deepEqual(Inputs.withInputs({}, {runtimeId: "native", graphicsInputs, declaredArchitecture: "arm64"}),
    {...graphicsInputs, architecture: "x86_64"});
  assert.equal(Inputs.resolveArchitecture({}, {runtimeId: "native", declaredArchitecture: "arm64"}), "arm64");
  assert.equal(graphicsInputs.architecture, "x64");
});
test("Native architecture fallback reads bounded Mach-O headers without executing the file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-inputs-"));t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const executable = path.join(directory, "NativePlayer"), bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);bytes.writeUInt32LE(0x01000007, 4);bytes.writeUInt32LE(2, 12);fs.writeFileSync(executable, bytes);
  const entry = {moduleData: {launchKind: "executable", executablePath: executable}};
  assert.equal(Inputs.resolveArchitecture(entry, {runtimeId: "native", hostArchitecture: "arm64"}), "x86_64");
  assert.deepEqual(require("../src/modules/generic-app/main").resolveGraphicsInputs(entry, {runtimeId: "native"}), {architecture: "x86_64"});
});
test("Unknown paths, scripts and other backends do not invent a native architecture", () => {
  assert.equal(Inputs.resolveArchitecture({}, {runtimeId:"native"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{launchKind:"script", executableArchitectures:["x86_64"]}}, {runtimeId:"native"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{executableArchitectures:["x86_64"]}}, {runtimeId:"godot"}), null);
  assert.equal(Inputs.resolveArchitecture({moduleData:{executablePath:"/missing/native"}}, {runtimeId:"native", readArchitectures:()=>{throw Error("missing");}}), null);
  const source={source:"renderer",cameraProjection:false,sourceResolution:false};
  assert.equal(Inputs.withInputs({}, {runtimeId:"native",graphicsInputs:source}), source);
});
test("Native engine bundles resolve their actual Info.plist executable before choosing graphics providers", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-graphics-bundle-"));t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bundle = (name, cpus) => {
    const root = path.join(directory, name + ".app"), macos = path.join(root, "Contents", "MacOS");fs.mkdirSync(macos, {recursive: true});
    fs.writeFileSync(path.join(root, "Contents", "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ActualPlayer</string></dict></plist>');
    const tableSize = 8 + cpus.length * 20, bytes = Buffer.alloc(cpus.length === 1 ? 32 : tableSize + cpus.length * 32);
    if (cpus.length === 1) {bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(cpus[0], 4);bytes.writeUInt32LE(2, 12);}
    else {bytes.writeUInt32BE(0xcafebabe);bytes.writeUInt32BE(cpus.length, 4);cpus.forEach((cpu, i) => {
      const offset = tableSize + i * 32;bytes.writeUInt32BE(cpu, 8 + i * 20);bytes.writeUInt32BE(offset, 16 + i * 20);bytes.writeUInt32BE(32, 20 + i * 20);
      bytes.writeUInt32LE(0xfeedfacf, offset);bytes.writeUInt32LE(cpu, offset + 4);bytes.writeUInt32LE(2, offset + 12);
    });}
    const executable = path.join(macos, "ActualPlayer");fs.writeFileSync(executable, bytes);
    fs.writeFileSync(path.join(macos, "NotThePlayer"), "other bundle file");return {root, executable};
  };
  const intel = bundle("Godot Intel", [0x01000007]), arm = bundle("Godot ARM", [0x0100000c]), universal = bundle("Godot Universal", [0x01000007, 0x0100000c]);
  const options = {runtimeId: "native", hostArchitecture: "arm64"};
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: intel.root, moduleData: {packPath: "/game/game.pck"}}, options), "x86_64");
  assert.equal(Inputs.resolveArchitecture({gamePath: arm.root}, options), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: universal.root}, options), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: universal.root}, {...options, hostArchitecture: "x64"}), "x86_64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: intel.root}, {...options, declaredArchitecture: "arm64"}), "arm64");
  assert.equal(Inputs.resolveArchitecture({nativeAppPath: path.join(directory, "Missing.app")}, options), null);
});

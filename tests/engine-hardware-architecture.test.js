// Required first: every upstream request remains offline in these policy tests.
require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Host = require("../src/modules/shared/runtime/host-capabilities");
const Architecture = require("../src/modules/shared/runtime/architecture");
const { ARM64, X64, image, universal } = require("./fixtures/macho-image");

function rosetta(t, hardwareArch = "arm64") {
  const original = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { value: "x64" });
  t.after(() => Object.defineProperty(process, "arch", original));
  const host = { platform: "darwin", launcherArch: "x64", hardwareArch, translated: hardwareArch === "arm64", rosettaAvailable: true, macOSVersion: "26.0" };
  t.mock.method(Host, "getHostCapabilities", () => host);
  return host;
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-hardware-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function write(root, relative, bytes) {
  const file = path.join(root, relative);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, bytes);return file;
}

test("an Intel launcher on Apple Silicon retains Intel Igor defaults while hardware gates official installation", async t => {
  const host = rosetta(t), root = temporary(t);
  const Installer = require("../src/modules/gamemaker/runtime/official-installer");
  const Catalog = require("../src/modules/gamemaker/runtime/official-catalog");
  const Official = require("../src/modules/gamemaker/runtime/official");
  const release = { version: "2026.1.0.1", channel: "Stable", source: Catalog.FEEDS[0].url, packages:
    ["core", "mac", "macYYC", "base-module-osx-arm64", "base-module-osx-x64"].map(module => ({ module })) };
  t.mock.method(Catalog, "cachedCatalog", () => ({ entries: [release], fetchedAt: 1 }));
  t.mock.method(Catalog, "stateFor", () => ({ status: "success", error: null }));
  assert.equal(Installer.bootstrapForArch(), Installer.BOOTSTRAPS.x64);
  assert.equal(Catalog.selectPackages(release).find(row => row.module.startsWith("base-module-")).module, "base-module-osx-x64");
  const state = Official.manager.getState({ userDataDir: root });
  assert.equal(state.catalog.installable, true);assert.deepEqual(state.catalog.installableVersions, [release.version]);
  assert.equal(state.setupActions[0].architecture, "x64", "tool identity remains tied to the launcher, not hardware");
  await assert.rejects(Installer.installOfficialVersion({ userDataDir: root, version: "invalid" }), /Select an exact official runtime version/);
  host.hardwareArch = "unsupported";
  assert.equal(Official.manager.getState({ userDataDir: root }).catalog.installable, false);
  await assert.rejects(Installer.installOfficialVersion({ userDataDir: root, version: "invalid" }), /requires an Apple Silicon or Intel Mac/);
});

test("legacy OpenGL helper eligibility consults physical hardware under an Intel launcher", t => {
  const host = rosetta(t), root = temporary(t), Fallback = require("../src/modules/gamemaker/runtime/opengl-fallback");
  const version = "0.1.0", directory = Fallback.__test.installDirectory(root, version);
  const bytes = universal([ARM64, X64].map(cpu => ({ cpu, bytes: image({ cpu }) })));
  const Native = require("../src/modules/shared/runtime/local-native");
  write(directory, "software-opengl.dylib", bytes);
  write(directory, "helper.json", JSON.stringify({ version, architecture: "universal", sourceSha256:
    "7b9e4779af97a2bd7d5f2dd5c1a643ebc9eabc864e649940b294b05d0724c994", binarySha256: Native.hashFile(path.join(directory, "software-opengl.dylib")) }));
  assert.equal(Fallback.getFallbackStatus({ userDataDir: root, helperVersion: version }).ready, true);
  host.hardwareArch = "unsupported";
  assert.match(Fallback.getFallbackStatus({ userDataDir: root, helperVersion: version }).reason, /requires an Apple Silicon or Intel Mac/);
});

function unityPayload(root, cpu) {
  const version = "2022.3.62f3", revision = "abcdef123456", contents = ".package/Unity.pkg/Payload/Variations/macos_arm64_player_nondevelopment_mono/UnityPlayer.app/Contents";
  write(root, contents + "/MacOS/UnityPlayer", Buffer.concat([image({ cpu, fileType: 2, installName: null }), Buffer.alloc(1200), Buffer.from(`\0${version} (${revision})\0`)]));
  write(root, contents + "/Frameworks/MonoEmbedRuntime/osx/libmono.0.dylib", "Mono fixture");
  write(root, contents + "/Data/Managed/etc/mono/config", "Mono configuration");
  return { version, upstreamRevision: revision };
}
test("Unity accepts an explicitly selected ARM player under Rosetta and rejects it on Intel hardware", async t => {
  const host = rosetta(t), Package = require("../src/modules/unity/runtime/package");
  const root = temporary(t), accepted = path.join(root, "accepted"), rejected = path.join(root, "rejected");
  const pin = unityPayload(accepted, ARM64);unityPayload(rejected, ARM64);
  const run = async (command, args) => { assert.equal(command, "/usr/bin/codesign");return { stdout: "", stderr: args.includes("--display") ? "code object is not signed at all" : "" }; };
  await Architecture.withArchitecture("arm64", async () => {
    const installed = await Package.prepareInstall({ unpacked: accepted, pin }, { run });
    assert.deepEqual(installed.architectures, ["arm64"]);
    host.hardwareArch = "x64";
    await assert.rejects(Package.prepareInstall({ unpacked: rejected, pin }, { run }), /does not support this Mac's CPU/);
  });
});

function scummvmPayload(root, executableCPU, libraryCPU = executableCPU) {
  const contents = "ScummVM.app/Contents";
  write(root, contents + "/MacOS/scummvm", image({ cpu: executableCPU, fileType: 2, installName: null }));
  write(root, contents + "/Frameworks/libfixture.dylib", image({ cpu: libraryCPU }));
  write(root, contents + "/Info.plist", '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>9.0.0</string></dict></plist>');
}
test("ScummVM installation checks hardware can run one common CPU across every loaded image", async t => {
  const host = rosetta(t), Signing = require("../src/modules/scummvm/runtime/signing"), root = temporary(t);
  const run = async (command, args) => { assert.equal(command, "/usr/bin/codesign");return { stdout: "", stderr: args[0] === "-d" ? "flags=0x2(adhoc)" : "" }; };
  for (const [name, executableCPU, libraryCPU, expected] of [["arm", ARM64, ARM64, "arm64"], ["intel", X64, X64, "x86_64"]]) {
    const unpacked = path.join(root, name);scummvmPayload(unpacked, executableCPU, libraryCPU);
    const installed = await Signing.prepareInstall({ unpacked, pin: { version: "9.0.0" } }, { run });
    assert.deepEqual(installed.architectures, [expected]);
    assert.deepEqual(Signing.launchRequirements({executablePath:path.join(unpacked,"ScummVM.app/Contents/MacOS/scummvm")}),
      {architecture:expected === "x86_64" ? "x64" : expected,needsRosetta:expected === "x86_64"});
  }
  const mixed = path.join(root, "mixed");scummvmPayload(mixed, ARM64, X64);
  await assert.rejects(Signing.prepareInstall({ unpacked: mixed, pin: { version: "9.0.0" } }, { run }), /does not support this Mac architecture/);
  host.hardwareArch = "x64";
  const armOnIntel = path.join(root, "arm-on-intel");scummvmPayload(armOnIntel, ARM64);
  await assert.rejects(Signing.prepareInstall({ unpacked: armOnIntel, pin: { version: "9.0.0" } }, { run }), /does not support this Mac architecture/);
});

test("ScummVM Universal launch selects a CPU present in the whole closure or rejects before spawning", async t => {
  const host = rosetta(t), Signing = require("../src/modules/scummvm/runtime/signing"), root = temporary(t);
  const run = async (_command,args) => ({stdout:"",stderr:args[0] === "-d" ? "flags=0x2(adhoc)" : ""});
  const main = universal([ARM64,X64].map(cpu => ({cpu,bytes:image({cpu,fileType:2,installName:null})})));
  for (const [name,cpu,expected] of [["intel-companion",X64,"x86_64"],["arm-companion",ARM64,"arm64"]]) {
    const unpacked = path.join(root,name); scummvmPayload(unpacked,cpu);
    const executablePath = write(unpacked,"ScummVM.app/Contents/MacOS/scummvm",main);
    const metadata = await Signing.prepareInstall({unpacked,pin:{version:"9.0.0"}},{run});
    assert.deepEqual(metadata.architectures,[expected],"signing reports common closure CPUs, not the Universal main's union");
    // Older installation metadata advertised both main slices; actual files remain authoritative.
    const install = {executablePath,installationMetadata:{...metadata,architectures:["arm64","x86_64"]}};
    for (const parent of ["x64","arm64"]) {
      Object.defineProperty(process,"arch",{value:parent}); host.launcherArch = parent;
      if (parent === "x64" && cpu === ARM64) assert.throws(() => Signing.launchRequirements(install), /child process architecture/);
      else assert.deepEqual(Signing.launchRequirements(install), {architecture:cpu === X64 ? "x64" : "arm64",needsRosetta:cpu === X64});
    }
    host.hardwareArch = "x64";
    if (cpu === ARM64) assert.throws(() => Signing.launchRequirements(install), /child process architecture/);
    host.hardwareArch = "arm64";
    write(unpacked,"ScummVM.app/Contents/Frameworks/libfixture.dylib",universal([ARM64,X64].map(cpu => ({cpu,bytes:image({cpu})}))));
    for (const parent of ["x64","arm64"]) {
      Object.defineProperty(process,"arch",{value:parent}); host.launcherArch = parent;
      assert.deepEqual(Signing.launchRequirements(install),{architecture:parent,needsRosetta:parent === "x64"});
    }
  }
});

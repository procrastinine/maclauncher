// Developer-only build recipe. CatSystem2 tools execute the sealed Included
// helper directly; end users need neither a compiler nor a runtime install.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const B = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Supplemental = require("../../../../scripts/native-supplementals.cjs");

const VERSION = "1.0.0-ml1", MINIMUM_MACOS = "11.0", SDK_VERSION = "27.0";
const COMPILER_VERSION = "Apple clang version 21.0.0 (clang-2100.3.34.2)";
const SOURCE = path.join(__dirname, "kif-crypto.c");
const REPO = path.resolve(__dirname, "../../../..");

function command(executable, args) {
  return execFileSync(executable, args, { timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function stage({ resourcesRoot } = {}) {
  if (process.platform !== "darwin" || !path.isAbsolute(resourcesRoot || "")) throw new Error("Build the KIF helper on macOS into an absolute resource staging directory.");
  const sdk = command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  const compiler = command("/usr/bin/xcrun", ["clang", "--version"]).split("\n")[0];
  if (sdk !== SDK_VERSION || compiler !== COMPILER_VERSION) throw new Error("Use the reviewed Apple clang 21.0.0 / macOS SDK 27.0 toolchain for this helper version.");
  const directoryRelative = `catsystem2-kif-crypto/${VERSION}/universal`;
  const destination = path.join(resourcesRoot, "native-runtimes", directoryRelative);
  if (fs.existsSync(destination)) throw new Error("The KIF helper package is immutable; stage into an empty resource directory.");
  const source = B.readRegular(SOURCE, 64 * 1024), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-kif-build-"));
  try {
    fs.mkdirSync(destination, { recursive: true });
    for (const arch of ["arm64", "x86_64"]) {
      command("/usr/bin/xcrun", ["--sdk", "macosx", "clang", "-arch", arch, `-mmacosx-version-min=${MINIMUM_MACOS}`,
        "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations",
        `-ffile-prefix-map=${REPO}=maclauncher-source`, SOURCE, "-o", path.join(temporary, arch)]);
    }
    const executable = path.join(destination, "kif-crypto");
    command("/usr/bin/lipo", ["-create", path.join(temporary, "arm64"), path.join(temporary, "x86_64"), "-output", executable]);
    command("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.github.maclauncher.kif-crypto", executable]);
    command("/usr/bin/codesign", ["--verify", "--strict", executable]);
    if (command(executable, ["--version"]) !== "maclauncher-kif-crypto 1.0.0") throw new Error("The new KIF helper cannot execute its declared protocol.");
    if (JSON.stringify(Native.readMachOArchitectures(executable).sort()) !== JSON.stringify(["arm64", "x86_64"])) throw new Error("KIF helper CPU slices differ.");
    for (const name of ["kif-crypto.c", "stage-crypto.cjs"]) fs.copyFileSync(path.join(__dirname, name), path.join(destination, name));
    fs.copyFileSync(path.join(REPO, "LICENSE"), path.join(destination, "MacLauncher-MIT.txt"));
    const dependencies = ["MacLauncher KIF cipher helper: owned MIT source, no third-party engine code or game assets.",
      "CommonCrypto: supplied by macOS through libSystem; not redistributed in this package.",
      "Protocol version: maclauncher-kif-crypto 1.0.0 / KBF1, four-byte minimum cyclic key, eight-byte little-endian blocks.",
      "Formats: https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/KIF-Archive",
      "Key resources: https://github.com/trigger-segfault/TriggersTools.CatSystem2/wiki/V_CODEs",
      "No game keys, Windows executable, Valve API or proprietary runtime is included."].join("\n") + "\n";
    fs.writeFileSync(path.join(destination, "DEPENDENCIES.txt"), dependencies);
    const files = fs.readdirSync(destination).sort().map(name => {
      fs.chmodSync(path.join(destination, name), name === "kif-crypto" ? 0o755 : 0o644);
      const file = B.readRegular(path.join(destination, name), 1024 * 1024);
      return { path: name, size: file.size, sha256: file.sha256, mode: file.mode,
        ...(name === "kif-crypto" ? { architectures: ["arm64", "x86_64"] } : {}) };
    });
    const notices = [{ name: "MacLauncher KIF cipher helper", license: "MIT", path: "MacLauncher-MIT.txt" }];
    const record = { schemaVersion: 1, id: "catsystem2-kif-crypto", version: VERSION, protocolVersion: "KBF1",
      sourceSha256: source.sha256, binarySha256: files.find(file => file.path === "kif-crypto").sha256,
      minimumMacOS: MINIMUM_MACOS, architectures: ["arm64", "x86_64"], scope: "kif-little-endian-blowfish",
      sourceKind: "owned-source", verifiedBuild: true,
      build: { compiler, sdk, signing: "ad-hoc", optimizations: "O2", minimumMacOS: MINIMUM_MACOS,
        recipe: "src/modules/catsystem2/runtime/stage-crypto.cjs", recipeSha256: files.find(file => file.path === "stage-crypto.cjs").sha256 }, files, notices };
    const metadata = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    fs.writeFileSync(path.join(destination, "helper.json"), metadata, { mode: 0o644 });
    const declaration = { id: record.id, version: VERSION, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS: MINIMUM_MACOS,
      sourceRelative: "kif-crypto.c", sourceSha256: source.sha256, directoryRelative, manifestRelative: "helper.json",
      manifestSha256: B.digest(metadata), files: [...files, { path: "helper.json", size: metadata.length, sha256: B.digest(metadata), mode: 0o644 }], notices };
    Supplemental.validateDeclaration(declaration);
    Supplemental.verifySupplementals({ resourceRoot: path.join(resourcesRoot, "native-runtimes"), arch: process.arch, maximumMacOS: MINIMUM_MACOS, items: [declaration] });
    return declaration;
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { VERSION, MINIMUM_MACOS, SDK_VERSION, COMPILER_VERSION, stage };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("Pass the resource staging directory explicitly.");
    process.stdout.write(JSON.stringify(stage({ resourcesRoot: path.resolve(process.argv[2]) }), null, 2) + "\n");
  }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}

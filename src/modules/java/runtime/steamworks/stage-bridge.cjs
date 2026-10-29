// Developer staging of publisher JNI binaries and the small owned loader.
// Runtime launch never downloads a SDK, compiles Java or rewrites this catalog.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Bundle = require("../../../shared/runtime/bundled-native");
const Zip = require("../../../shared/runtime/zip");
const Native = require("../../../shared/runtime/local-native");
const { build } = require("./build-agent.cjs");
const Catalog = require("./versions.json");

const COMPILER_RUNTIME = "17.0.20.1+1";
function stage({ references, jdkBin, resourcesRoot } = {}) {
  if (![references, jdkBin, resourcesRoot].every(value => path.isAbsolute(value || "")))
    throw new Error("Pass absolute publisher-reference, JDK bin and resource directories.");
  const release = Bundle.readRegular(path.join(jdkBin, "../release"), 64 * 1024).bytes.toString("utf8");
  if (!release.includes('JAVA_RUNTIME_VERSION="' + COMPILER_RUNTIME + '"'))
    throw new Error("Use the explicitly reviewed Temurin compiler runtime " + COMPILER_RUNTIME + ".");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-java-steam-stage-"));
  const declarations = [], pins = [];
  try {
    const agent = path.join(temporary, "steam-agent.jar"), built = build(jdkBin, agent);
    const second = path.join(temporary, "steam-agent-second.jar");
    if (build(jdkBin, second).sha256 !== built.sha256) throw new Error("Java loader builds are not reproducible.");
    for (const original of Catalog) {
      const publisher = path.join(references, "steamworks4j-" + original.version + ".jar");
      if (Bundle.readRegular(publisher, 8 * 1024 * 1024).sha256 !== original.publisherJarSha256)
        throw new Error("The exact publisher Steam wrapper archive changed.");
      const bytes = Zip.readZipEntryBuffer(publisher, "libsteamworks4j.dylib");
      if (!bytes || Bundle.digest(bytes) !== original.jniSha256 || bytes.length !== original.jniSize)
        throw new Error("The exact publisher JNI entry changed.");
      const arch = original.architectures.length === 1 ? "x64" : "universal";
      const directoryRelative = "java-steamworks/" + original.bridgeVersion + "/" + arch;
      const directory = path.join(resourcesRoot, "native-runtimes", directoryRelative);
      if (fs.existsSync(directory)) throw new Error("Stage into an empty resource directory; existing sealed JNI packages are immutable.");
      fs.mkdirSync(directory, { recursive: true });
      const libraryPath = path.join(directory, "libsteamworks4j.dylib");
      fs.writeFileSync(libraryPath, bytes, { mode: 0o755 });
      if (JSON.stringify(Native.readMachOArchitectures(libraryPath, { allowLibrary: true }).sort()) !== JSON.stringify(original.architectures.slice().sort()))
        throw new Error("The publisher JNI CPU inventory changed.");
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", libraryPath], { timeout: 30000, stdio: "pipe" });
      fs.copyFileSync(agent, path.join(directory, "steam-agent.jar"));
      fs.copyFileSync(path.join(__dirname, "steamworks4j-" + original.version + "-MIT.txt"), path.join(directory, "steamworks4j-MIT.txt"));
      fs.copyFileSync(path.resolve(__dirname, "../../../../../LICENSE"), path.join(directory, "MacLauncher-MIT.txt"));
      const dependencies = [
        "steamworks4j " + original.version + ": publisher JNI binary, unchanged. MIT.",
        "Source: " + original.sourceUrl,
        "Source revision: " + original.sourceRevision,
        "Publisher archive: " + original.publisherUrl,
        "Archive SHA-256: " + original.publisherJarSha256,
        "JNI SHA-256: " + original.jniSha256,
        "MacLauncher Java loader: owned MIT source; compiled for Java 8 (class major 52).",
        "Compiler: Eclipse Temurin " + COMPILER_RUNTIME + "; two matching deterministic builds.",
        "Steam API: separate versioned Goldberg-mac helper or the game's compatible native library.",
        "No official Valve Steam API/ticket library or SDK is included in this package.",
        "The game retains its original JAR, initialization, callbacks and shutdown."
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(directory, "DEPENDENCIES.txt"), dependencies);
      const files = fs.readdirSync(directory).sort().map(name => {
        fs.chmodSync(path.join(directory, name), name === "libsteamworks4j.dylib" ? 0o755 : 0o644);
        const item = Bundle.readRegular(path.join(directory, name), 8 * 1024 * 1024);
        return { path: name, size: item.size, sha256: item.sha256, mode: item.mode,
          ...(name === "libsteamworks4j.dylib" ? { architectures: original.architectures,
            ...(arch === "x64" ? { executionArchitecture: "x86_64" } : {}) } : {}) };
      });
      const notices = [{ name: "steamworks4j " + original.version, license: "MIT", path: "steamworks4j-MIT.txt", sourceUrl: original.sourceUrl },
        { name: "MacLauncher Java loader", license: "MIT", path: "MacLauncher-MIT.txt" }];
      const record = { schemaVersion: 1, id: "java-steamworks", version: original.bridgeVersion, wrapperVersion: original.version,
        sourceRevision: original.sourceRevision, sourceUrl: original.sourceUrl, sourceKind: "reviewed-binary", verifiedBuild: false,
        publisherUrl: original.publisherUrl, publisherJarSha256: original.publisherJarSha256,
        librarySha256: original.jniSha256, agentSha256: built.sha256, agentSourceSha256: built.sourceSha256,
        agentCompilerRuntime: COMPILER_RUNTIME, agentClassMajor: 52, abiProfile: original.abiProfile,
        minimumMacOS: arch === "x64" ? "10.9" : "11.0", architectures: original.architectures,
        interfaces: original.interfaces, symbols: original.symbols, files, notices };
      const manifestPath = path.join(directory, "helper.json");
      fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o644 });
      const manifest = Bundle.readRegular(manifestPath, 128 * 1024);
      const allFiles = [...files, { path: "helper.json", size: manifest.size, sha256: manifest.sha256, mode: manifest.mode }];
      Bundle.verifyPayload(directory, { files: allFiles });
      declarations.push({ id: "java-steamworks", version: original.bridgeVersion, arch,
        launcherArchitectures: ["arm64", "x64"], minimumMacOS: record.minimumMacOS,
        sourceRelative: null, sourceSha256: built.sourceSha256,
        directoryRelative, manifestRelative: "helper.json", manifestSha256: manifest.sha256, files: allFiles, notices });
      pins.push({ ...original, agentSha256: built.sha256, agentSourceSha256: built.sourceSha256, agentCompilerRuntime: COMPILER_RUNTIME,
        minimumMacOS: record.minimumMacOS });
    }
    return { pins, declarations, agent: built };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (require.main === module) console.log(JSON.stringify(stage({ references: process.argv[2], jdkBin: process.argv[3], resourcesRoot: process.argv[4] }), null, 2));
module.exports = { COMPILER_RUNTIME, stage };

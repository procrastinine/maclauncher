import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import B from "../src/modules/shared/runtime/bundled-native.js";
import Native from "../src/modules/shared/runtime/local-native.js";
import Staging from "./stage-native-runtimes.cjs";
import Supplemental from "./native-supplementals.cjs";
import {verifyAndroidSourceSnapshot, copyAndroidSourceSnapshot, archiveAndroidUpstreamSource, archiveAndroidSourceTree, filterAndroidSourceArchive} from "./android-stage-sources.mjs";
import {copyAndroidProducts, publishAndroidAngle, publishAndroidNotices, publishAndroidDeclaration} from "./android-products.mjs";

const repo = path.resolve(import.meta.dirname, ".."), moduleRoot = path.join(repo, "src/modules/android");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--build", "--klepton", "--dex2jvm", "--codec-sources", "--gles-headers"].includes(key) || !process.argv[i + 1] || options[key])
    throw new Error("Usage: node scripts/stage-android.mjs --build <build> --klepton <source> --dex2jvm <source> --codec-sources <archives> [--gles-headers <source>]");
  options[key] = fs.realpathSync(process.argv[i + 1]);
}
if (["--build", "--klepton", "--dex2jvm", "--codec-sources"].some(name => !options[name]))
  throw new Error("The Android build, Klepton, converter and codec source paths are required.");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file));
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 ** 2 });
const receipt = read(path.join(options["--build"], "build-receipt.json"));
const buildSource = path.join(options["--build"], "source");
// The selected completed build owns its exact source/version identity. Ongoing
// development in the working checkout must not prevent selecting a built version.
const pins = read(path.join(buildSource, "native/source-pins.json"));
const Profile = createRequire(import.meta.url)(path.join(buildSource, "profile.js"));
const profile = Profile.runtimeProfile(pins);
const identity = verifyAndroidSourceSnapshot(buildSource, receipt);
if(pins.frameworkBaseVersion===1&&JSON.stringify(receipt.framework)!==JSON.stringify(read(path.join(buildSource,"native/framework-binary.json"))))
  throw new Error("Android framework artifact identity differs from the build.");
if (receipt.schemaVersion !== 2 || JSON.stringify(receipt.pins) !== JSON.stringify(pins) ||
    receipt.inputs?.sourceHash !== identity.sourceHash || digest(JSON.stringify(receipt.inputs)) !== receipt.inputHash || !Array.isArray(receipt.products))
  throw new Error("Android build source identity is invalid.");
let glesHeaders;
if (pins.glesHeaders != null || receipt.glesHeaders != null) {
  if (!options["--gles-headers"]) throw new Error("This Android build requires --gles-headers.");
  const {verifyGlesHeaders} = await import("../src/modules/android/native/gles-headers.mjs");
  glesHeaders = verifyGlesHeaders(options["--gles-headers"]);
  if (glesHeaders.revision !== pins.glesHeaders || JSON.stringify(glesHeaders) !== JSON.stringify(receipt.glesHeaders))
    throw new Error("Android GLES header source identity is invalid.");
} else if (options["--gles-headers"]) throw new Error("This Android build does not consume GLES headers.");
for (const name of ["klepton", "dex2jvm"]) {
  if (run("git", ["-C", options["--" + name], "rev-parse", "HEAD"]).trim() !== pins[name] ||
      run("git", ["-C", options["--" + name], "status", "--porcelain", "--untracked-files=no"]).trim())
    throw new Error("Android upstream checkout differs from its source pin: " + name);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-android-stage-"));
try {
  const payload = path.join(temporary, "payload"), sources = path.join(temporary, "sources");
  fs.mkdirSync(payload); fs.mkdirSync(sources);
  const copy = (input, output) => {
    const stat = fs.lstatSync(input);
    if (!stat.isFile()) throw new Error("Android staging requires regular files: " + input);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(input, output);
    if(input.startsWith(options["--build"]+path.sep)&&!input.startsWith(buildSource+path.sep)){
      const relative=path.relative(options["--build"],input),product=receipt.products.find(item=>item.path===relative);
      if(!product||product.sha256!==digest(fs.readFileSync(output)))throw new Error("Android build product changed after compilation: "+relative);
    }
    fs.chmodSync(output, stat.mode & 0o111 ? 0o755 : 0o644);
  };
  copyAndroidProducts(options["--build"],payload,receipt.products);
  publishAndroidAngle(payload,receipt.products,receipt.angle);
  publishAndroidNotices(payload,receipt.pathMappings||[]);
  if(receipt.framework?.nativeRuntime){
    const nativeRuntime=receipt.framework.nativeRuntime,name=nativeRuntime.path;
    if(name!=="libandroid_runtime.dylib")throw new Error("Unexpected Android framework native library");
    const bytes=fs.readFileSync(path.join(payload,"native",name));
    if(bytes.length!==nativeRuntime.size||digest(bytes)!==nativeRuntime.sha256)
      throw new Error("Android framework native library differs from its publisher identity");
    for(const data of nativeRuntime.data||[]){
      if(!/^icudt[0-9]+l\.dat$/.test(data.path))throw new Error("Unexpected Android framework native data file");
      const target=path.join(payload,"native",data.path);
      const bytes=fs.readFileSync(target);
      if(bytes.length!==data.size||digest(bytes)!==data.sha256)
        throw new Error("Android framework native data differs from its publisher identity");
    }
  }
  copy(path.join(repo, "LICENSE"), path.join(payload, "notices/MacLauncher.txt"));

  const files = [], dependencies = [];
  let minimumMacOS = "0.0";
  for (const name of B.fileInventory(payload)) {
    const file = path.join(payload, name), bytes = fs.readFileSync(file);
    const isMachO = bytes.length >= 4 && [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe,
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32LE(0));
    const architectures = isMachO ? Native.readMachOArchitectures(file, { allowLibrary: true }) : [];
    const record = { path: name, size: bytes.length, mode: fs.statSync(file).mode & 0o777, sha256: digest(bytes) };
    if (architectures.length) {
      if (!architectures.includes("arm64")) throw new Error("Android native dependency lacks Apple Silicon: " + name);
      record.architectures = architectures;
      const commands = Staging.loadCommands(file);
      if (B.versionAtLeast(commands.minimumMacOS, minimumMacOS)) minimumMacOS = commands.minimumMacOS;
      if (commands.rpaths.some(value => !/^@(loader_path|executable_path)(?:\/|$)/.test(value)))
        throw new Error("Unexpected Android library search path: " + name);
      const ids = new Set(Staging.libraryIds(file));
      const links = Staging.links(file).filter(link => !ids.has(link));
      for (const link of links) {
        if (link.startsWith("/usr/lib/") || link.startsWith("/System/Library/")) continue;
        const relative = link.startsWith("@loader_path/") ? link.slice(13) :
          link.startsWith("@rpath/") && commands.rpaths.includes("@loader_path") ? link.slice(7) : null;
        if (!relative) throw new Error("Android dependency is not loader-relative: " + name + " → " + link);
        const target = path.resolve(path.dirname(file), relative);
        if (!target.startsWith(payload + path.sep) || !fs.lstatSync(target).isFile())
          throw new Error("Android dependency leaves its payload: " + name);
      }
      run("/usr/bin/codesign", ["--verify", "--strict", file]);
      dependencies.push({ file: name, links });
    }
    files.push(record);
  }
  copyAndroidSourceSnapshot(buildSource, identity, sources, copy);
  for (const name of ["LICENSE", "scripts/stage-android.mjs", "scripts/android-stage-sources.mjs", "scripts/android-products.mjs", "scripts/runtime-content.cjs", "src/core/json-files.js", "src/modules/shared/runtime/runtime-content.js", "src/modules/shared/runtime/portable-sndfile.json", "src/modules/shared/runtime/portable-sndfile.js"])
    copy(path.join(repo, name), path.join(sources, name));
  for (const name of ["klepton", "dex2jvm"]) {
    const archive = path.join(sources, name + ".tar");
    // The XR producer consumes these Metal texture-provider helpers. Preserve
    // their original paths so the completed producer's includes still resolve.
    const productionInputs = name === "klepton" ? ["tests/t_mtl_provider.m", "tests/t_mtl_provider.h"] : [];
    // The owned macOS source-list target consumes the original Makefile and
    // runtime units; other upstream frontends and tools are independent.
    const sourceRoots = name === "klepton" ? ["LICENSE", "Makefile", "runtime", ...productionInputs] : ["."];
    archiveAndroidUpstreamSource(options["--" + name], pins[name], archive, {productionInputs, sourceRoots});
  }
  if (glesHeaders) {
    for (const entry of [...glesHeaders.files,...(glesHeaders.registry?[glesHeaders.registry]:[])])
      copy(path.join(options["--gles-headers"], entry.path), path.join(sources, "gles-headers", entry.path));
    fs.writeFileSync(path.join(sources, "gles-headers/source.json"), JSON.stringify(glesHeaders, null, 2) + "\n");
  }
  const codecs = read(path.join(repo, "src/modules/shared/runtime/portable-sndfile.json"));
  const archives = fs.readdirSync(options["--codec-sources"]).filter(name => /\.tar\.(?:gz|bz2)$/.test(name))
    .map(name => ({ name, bytes: fs.readFileSync(path.join(options["--codec-sources"], name)) }));
  const codecSources = [];
  for (const codec of codecs.dependencies) {
    const input = archives.find(item => item.bytes.length === codec.archiveBytes && digest(item.bytes) === codec.archiveSha256);
    if (!input) throw new Error("Missing corresponding codec source: " + codec.name);
    const output = path.join(sources, "codecs", input.name);
    fs.mkdirSync(path.dirname(output), {recursive:true});
    filterAndroidSourceArchive(path.join(options["--codec-sources"], input.name), output);
    const published = fs.readFileSync(output);
    codecSources.push({path:input.name, sourceArchiveSha256:codec.archiveSha256, sourceArchiveBytes:codec.archiveBytes,
      publishedArchiveSha256:digest(published), publishedArchiveBytes:published.length});
  }
  fs.writeFileSync(path.join(sources, "codecs/source.json"), JSON.stringify({schemaVersion:1, archives:codecSources}, null, 2) + "\n");
  fs.writeFileSync(path.join(sources, "source-pins.json"), JSON.stringify(pins, null, 2) + "\n");
  archiveAndroidSourceTree(sources, path.join(payload, "source.tar.gz"));
  function record(name) {
    const file = path.join(payload, name); fs.chmodSync(file, 0o644);
    return { path: name, size: fs.statSync(file).size, mode: 0o644, sha256: digest(fs.readFileSync(file)) };
  }
  const source = record("source.tar.gz"); files.push(source);
  const payloadHash = digest(JSON.stringify(files));
  const version = pins.version + "-" + receipt.inputHash.slice(0, 8) + "-" + payloadHash.slice(0, 8);
  const runtime = { schemaVersion: 1, version, profile, minimumMacOS, architectures: ["arm64"],
    sourceHash: receipt.sourceHash, inputHash: receipt.inputHash, pins, dependencies, files };
  Supplemental.validatePublicMetadata(runtime);
  fs.writeFileSync(path.join(payload, "runtime.json"), JSON.stringify(runtime, null, 2) + "\n");
  const manifest = record("runtime.json"); files.push(manifest);
  const notices = files.filter(file => file.path.startsWith("notices/") && !file.path.endsWith(".json"))
    .map(file => ({ name: file.path.slice(8).replaceAll("/", " — "), license: "See included license", path: file.path }));
  const declaration = { id: "android", version, arch: "arm64", launcherArchitectures: ["arm64"], minimumMacOS,
    sourceRelative: source.path, sourceSha256: source.sha256, directoryRelative: `android/${version}/arm64`,
    manifestRelative: manifest.path, manifestSha256: manifest.sha256, files, notices };
  Supplemental.validateDeclaration(declaration); B.verifyPayload(payload, declaration);
  const destination = path.join(repo, "src/resources/native-runtimes", declaration.directoryRelative);
  if (fs.existsSync(destination)) B.verifyPayload(destination, declaration);
  else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const pending = fs.mkdtempSync(path.join(path.dirname(destination), ".android-publish-"));
    try {
      fs.cpSync(payload, path.join(pending, "payload"), { recursive: true });
      fs.renameSync(path.join(pending, "payload"), destination);
    } finally { fs.rmSync(pending, { recursive: true, force: true }); }
  }
  publishAndroidDeclaration(declaration,{moduleRoot});
  console.log(JSON.stringify({ destination, version, minimumMacOS, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

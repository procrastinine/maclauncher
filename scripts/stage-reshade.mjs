import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Native from "../src/modules/shared/runtime/local-native.js";
import { validateEffectSources } from "./reshade-effect-sources.mjs";
import { verifyReShadeCompiler } from "./reshade-compiler-contract.mjs";
import Content from "./runtime-content.cjs";
import Production from "../src/modules/shared/runtime/production-source.js";
import { productionOwnedFiles, copyPinnedReShadeSources } from "./stage-reshade-source.mjs";
const features = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/features.json"), "utf8"));
const effectSources = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/effect-sources.json"), "utf8"));

if (process.argv[2] === "--effects-only") {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/stage-reshade.mjs --effects-only");
  const { stageReShadeEffects } = await import("./stage-reshade-effects.mjs");
  console.log(JSON.stringify(stageReShadeEffects({ features, effectSources })));
  process.exit(0);
}
const args = process.argv.slice(2), source = args.shift();
if (!source) throw new Error("A ReShade macOS source directory is required.");
const build = path.resolve(source, args[0] && !args[0].startsWith("--") ? args.shift() : "build-physical");
const options = {};
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!["--owned-source", "--fsr", "--fsr4", "--godot", "--streamline", "--dxmt", "--retroarch", "--libplacebo", "--neural"].includes(key) || !value || value.startsWith("--") || options[key])
    throw new Error("Usage: node scripts/stage-reshade.mjs <source> [build] [--owned-source <source>] [--fsr <payload>] [--fsr4 <payload>] [--godot <payload>] [--streamline <payload>] [--dxmt <payload>] [--retroarch <payload>] [--libplacebo <payload>] [--neural <payload>]");
  options[key] = path.resolve(value);
}
// Owned adaptations may be built outside the read-only pinned checkout. Vendor
// revisions and license sources still come from that original checkout.
const ownedSource = options["--owned-source"] || source;
// Check the actual linked library before copying any payload. This also covers
// incremental developer builds whose consumers may have used older headers.
const planCheckDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-linked-plan-"));
try {
  const check = path.join(planCheckDirectory, "temporal-plan-test");
  const checkEnvironment = { ...process.env };
  for (const name of Object.keys(checkEnvironment))
    if (/^(DYLD_|RESHADE_|KLEPTON_|KL_)/.test(name)) delete checkEnvironment[name];
  execFileSync("/usr/bin/c++", ["-std=c++17", "-fobjc-arc", "-I" + path.join(ownedSource, "src"),
    path.join(ownedSource, "tests/temporal-plan.mm"), "-o", check, "-L" + build, "-lreshade-macos",
    "-Wl,-rpath," + build, "-framework", "Foundation", "-framework", "Metal", "-framework", "QuartzCore"],
  { env: checkEnvironment, timeout: 30000, maxBuffer: 1 << 20 });
  execFileSync(check, [], { env: { ...checkEnvironment, RESHADE_EXPLICIT_HOST: "1" }, timeout: 15000, maxBuffer: 1 << 20 });
} finally {
  fs.rmSync(planCheckDirectory, { recursive: true, force: true });
}
const resourceRoot = path.resolve(import.meta.dirname, "../src/resources/native-runtimes");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const owned = productionOwnedFiles(ownedSource);
const sourcePolicy = ["scripts/stage-reshade-source.mjs", "src/modules/shared/runtime/production-source.js", "src/modules/shared/runtime/runtime-content.js"]
  .map(file => fs.readFileSync(path.resolve(import.meta.dirname, "..", file)));
let sourceHash = digest(Buffer.concat([Buffer.from("production-source-v1\0"), ...sourcePolicy,
  ...owned.map(name => Buffer.concat([Buffer.from(name + "\0"), fs.readFileSync(path.join(ownedSource, name))]))]));
const consumed = new Set(["third_party/reshade", "third_party/reshade/deps/spirv", "third_party/spirv-cross", "third_party/reshade-shaders", "third_party/mako", "third_party/vkd3d", "third_party/fsr"]);
const pins = execFileSync("git", ["-C", source, "submodule", "status", "--recursive"], { encoding: "utf8" }).split("\n")
  .filter(line => consumed.has(line.slice(1).trim().split(/\s+/)[1]));
if (pins.length !== consumed.size || pins.some(line => !line.startsWith(" "))) throw new Error("Consumed ReShade source submodules must match their recorded commits.");
const nativeFiles = ["libreshade-macos.dylib", "libvkd3d-shader.dylib", "fx-compile"];
if(fs.existsSync(path.join(build,"maclauncher-graphics-video"))) nativeFiles.push("maclauncher-graphics-video");
const retroarchInputs = new Map();
const extraSources=[];
const optionalInputs=new Map(),optionalLoad=new Map(),extraOwned=new Map();
if (options["--neural"]) {
  const directory = options["--neural"], source = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/neural/source.json"), "utf8"));
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
  if (descriptor.providerABI !== source.providerABI || descriptor.commit !== source.commit || descriptor.library !== source.library ||
      descriptor.minimumMacOS !== source.minimumMacOS || descriptor.architectures?.join() !== "arm64" || !Array.isArray(descriptor.files)) throw new Error("A compatible neural rendering provider is required.");
  const required = new Set([source.library, "mlx.metallib", "maclauncher-neural-video"]);
  for (const entry of descriptor.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid neural provider path.");
    const file = path.join(directory, entry.path), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== entry.size || digest(fs.readFileSync(file)) !== entry.sha256) throw new Error("The neural provider changed.");
    const relative = "neural/" + entry.path;
    optionalInputs.set(relative, file); required.delete(entry.path);
    if (/\.(dylib|so)$/.test(entry.path) || entry.path === "maclauncher-neural-video") optionalLoad.set(relative, {architectures: ["arm64"], minimumMacOS: entry.path === "maclauncher-neural-video" ? "26.0" : source.minimumMacOS});
  }
  if (required.size) throw new Error("The neural provider dependency closure is incomplete.");
  optionalInputs.set("neural/provider.json", path.join(directory, "provider.json"));
  const neuralRoot = path.resolve(import.meta.dirname, "../src/modules/shared/reshade/neural");
  const upstream = path.resolve(import.meta.dirname, "../src/external/MLX-DLSS");
  const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== source.commit) throw new Error("The neural source revision differs from its provider.");
  const { patchKernelParameters, kernelParametersFile, kernelParametersSourceHash } = await import("../src/modules/shared/reshade/neural/native/prepare-upstream.mjs");
  const adaptation = JSON.parse(fs.readFileSync(path.join(directory, "adaptation.json"), "utf8"));
  const appliedSha256 = digest(patchKernelParameters(fs.readFileSync(path.join(upstream, kernelParametersFile), "utf8")));
  if (adaptation.schema !== 1 || adaptation.upstreamCommit !== source.commit || adaptation.adaptations?.length !== 1 ||
      adaptation.adaptations[0].id !== "kernel-parameters-cache-lock-v2" || adaptation.adaptations[0].file !== kernelParametersFile ||
      adaptation.adaptations[0].sourceSha256 !== kernelParametersSourceHash || adaptation.adaptations[0].appliedSha256 !== appliedSha256)
    throw new Error("The neural provider does not contain the registered source adaptation.");
  for (const relative of ["source.json", "build.mjs", "native/build.sh", "native/prepare-upstream.mjs", "native/Package.swift",
    "native/Package.resolved", "native/upstream.json", ...fs.readdirSync(path.join(neuralRoot, "native/Sources"), { recursive: true })
      .map(name => "native/Sources/" + name).filter(name => fs.statSync(path.join(neuralRoot, name)).isFile())]) {
    if (Content.excludedReason(relative)) throw new Error("The neural build recipe contains excluded runtime content.");
    extraOwned.set("maclauncher/neural/" + relative, path.join(neuralRoot, relative));
  }
  extraOwned.set("maclauncher/neural/adaptation.json", path.join(directory, "adaptation.json"));
  extraSources.push({ directory: upstream, relative: "third_party/MLX-DLSS", commit: revision,
    scope: ["Package.swift", "Package.resolved", "Sources/DLSSCore", "Sources/DLSSMLX", "Sources/DLSSMedia", "LICENSE", "NOTICE"] });
  pins.push(` ${revision} third_party/MLX-DLSS`);
}
const processorSources=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/processor-sources.json");
if(fs.existsSync(processorSources)) {
  const metadata=JSON.parse(fs.readFileSync(processorSources,"utf8"));
  const overlay=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/source-overlay.json"),"utf8"));
  const observed=new Map(pins.map(line=>{const [commit,file]=line.trim().split(/\s+/);return[file,commit];}));
  if(metadata.schema!==1||metadata.baseSourceHash!==overlay.baseSourceHash||!Array.isArray(metadata.sources)||metadata.sources.length!==consumed.size||
      new Set(metadata.sources.map(item=>item.sourcePath)).size!==consumed.size||metadata.sources.some(item=>observed.get(item.sourcePath)!==item.commit))
    throw new Error("The processor source identities differ from the consumed pins.");
  extraOwned.set("maclauncher/native/processor-sources.json",processorSources);
}
let libplacebo;
if(options["--libplacebo"]) {
  const directory=options["--libplacebo"];
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  if(metadata.schema!==1||metadata.provider!=="libplacebo"||metadata.library!=="libmacfx-libplacebo.dylib"||metadata.helper!=="libplacebo-prepare"||
      !Array.isArray(metadata.architectures)||!metadata.architectures.length||new Set(metadata.architectures).size!==metadata.architectures.length||metadata.architectures.some(arch=>!["arm64","x86_64"].includes(arch))||metadata.minimumMacOS!=="15.0"||!Array.isArray(metadata.files))throw new Error("A complete optional shader provider is required.");
  const required=new Set([metadata.library,metadata.helper,"libplacebo/liblcms2.2.dylib","libplacebo/libMoltenVK.dylib","libplacebo/libplacebo.360.dylib","libplacebo/libshaderc_shared.1.dylib"]);
  for(const entry of metadata.files) {
    if(typeof entry.path!=="string"||path.isAbsolute(entry.path)||entry.path.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||optionalInputs.has(entry.path))throw new Error("Invalid optional provider path.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.size||digest(fs.readFileSync(file))!==entry.sha256)throw new Error("The optional shader provider changed.");
    optionalInputs.set(entry.path,file);
    if(required.delete(entry.path))optionalLoad.set(entry.path,{architectures:metadata.architectures,minimumMacOS:metadata.minimumMacOS});
    else if(!entry.path.startsWith("notices/libplacebo/")||!entry.path.endsWith(".LICENSE"))throw new Error("Unexpected optional provider file.");
  }
  if(required.size)throw new Error("The optional shader provider dependency closure is incomplete.");
  optionalInputs.set("libplacebo/provider.json",path.join(directory,"provider.json"));
  for(const [relative,file] of [
    ["maclauncher/libplacebo-build.mjs","src/modules/shared/reshade/libplacebo-build.mjs"],
    ...["libplacebo-node.hpp","libplacebo-node.mm","libplacebo-prepare.mm","test/libplacebo-node.mm"].map(name=>["maclauncher/native/"+name,"src/modules/shared/reshade/native/"+name])
  ])if(!Content.excludedReason(relative))extraOwned.set(relative,path.resolve(file));
  libplacebo=metadata;
}else if(features.shaders.formats?.includes("libplacebo"))throw new Error("The declared optional shader format requires its complete provider.");
if(extraOwned.size)sourceHash=digest(Buffer.concat([Buffer.from(sourceHash+'\0'),...[...extraOwned].flatMap(([relative,file])=>[Buffer.from(relative+'\0'),fs.readFileSync(file)])]));
if(options["--retroarch"]) {
  const directory=options["--retroarch"];
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,"runtime-files.json"),"utf8"));
  const required=new Set(["librashader.dylib","retroarch-prepare","notices/librashader/LICENSE.md","notices/librashader/source.json"]);
  if(!Array.isArray(manifest.files)||manifest.files.length!==required.size)throw new Error("A complete RetroArch shader payload is required.");
  for(const entry of manifest.files) {
    if(!required.delete(entry.path))throw new Error("Unexpected RetroArch shader payload file.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.size||digest(fs.readFileSync(file))!==entry.sha256)
      throw new Error("The RetroArch shader payload changed.");
    retroarchInputs.set(entry.path,file);
  }
  const pin=JSON.parse(fs.readFileSync(retroarchInputs.get("notices/librashader/source.json"),"utf8"));
  const original=path.resolve(import.meta.dirname,"../src/external/librashader");
  const actual=execFileSync("git",["-C",original,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  if(actual!==pin.commit)throw new Error("The original librashader source pin differs from its payload.");
  extraSources.push({directory:original,relative:"third_party/librashader",commit:actual});
  pins.push(` ${actual} third_party/librashader`);
  nativeFiles.push("librashader.dylib","retroarch-prepare");
}else if(features.shaders.formats?.some(format=>format!=="fx"))throw new Error("The declared shader formats require the complete RetroArch shader payload.");
const temporalInputs = new Map();
for (const name of ["fsr", "fsr4"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
  if (metadata.providerABI !== 1 || metadata.complete !== true) throw new Error("A complete temporal provider payload is required.");
  for (const relative of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Temporal payloads must contain regular files.");
    if (stat.isFile()) temporalInputs.set(`temporal/${name}/${relative}`, file);
  }
}
for (const method of features.graphics.temporalMethods || []) {
  if (method === "metalfx") continue;
  const name = method === "fsr4" ? "fsr4" : "fsr";
  if (!temporalInputs.has(`temporal/${name}/libmaclauncher-${method}.dylib`)) throw new Error(`The ${method} provider payload is required by graphics capabilities.`);
}
for (const name of ["godot", "streamline", "dxmt"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, name === "dxmt" ? "camera-bridge.json" : "provider.json")));
  const selected = name === "godot" ? ["libmaclauncher-godot-camera.dylib", "provider.json", "GODOT-LICENSE.txt", "autoload.gd", "camera-effect.gd"]
    : name === "streamline" ? ["sl.interposer.dll", "provider.json", "Streamline-LICENSE.txt"]
    : [...Object.keys(metadata.files).filter(name=>name!=="source.tar.gz"), "camera-bridge.json", "LICENSE", "LICENSE.OLD", "COPYING.LIB"];
  if (name === "godot" ? metadata.abi !== 1 || metadata.complete !== true : metadata.schema !== 1)
    throw new Error("Unsupported camera bridge metadata.");
  for (const relative of selected) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid camera bridge path.");
    const file = path.join(directory, relative);
    if (!fs.lstatSync(file).isFile()) throw new Error("Camera bridges must contain regular files.");
    const expected = name === "dxmt" ? metadata.files[relative] : name === "streamline" && relative === metadata.library ? metadata.sha256 : null;
    if (expected && digest(fs.readFileSync(file)) !== expected) throw new Error("Camera bridge payload changed.");
    temporalInputs.set(`${name === "godot" ? "godot" : "temporal/" + name}/${relative}`, file);
  }
}
const nativePaths = new Map(nativeFiles.map(file => [file, path.join(build, file)]));
for(const [relative,file] of retroarchInputs)if(nativeFiles.includes(relative))nativePaths.set(relative,file);
for(const [relative,load] of optionalLoad){nativeFiles.push(relative);nativePaths.set(relative,optionalInputs.get(relative));}
if(nativeFiles.includes("maclauncher-graphics-video")) optionalLoad.set("maclauncher-graphics-video", {architectures: ["arm64", "x86_64"], minimumMacOS: "14.0"});
for (const [relative, file] of temporalInputs) if (/\.(dylib|so)$/.test(relative)) { nativeFiles.push(relative); nativePaths.set(relative, file); }
const nativeArchitectures = new Map();
for (const file of nativeFiles) {
  const architectures = Native.readMachOArchitectures(nativePaths.get(file), { allowLibrary: /\.(dylib|so)$/.test(file) });
  const required = optionalLoad.get(file)?.architectures || (file.startsWith("temporal/dxmt/") ? ["x86_64"] : ["arm64", "x86_64"]);
  if (!required.every(arch => architectures.includes(arch))) throw new Error(`${file} is missing a required architecture.`);
  nativeArchitectures.set(file, architectures);
}
// Verify the compiler's CPU-only inspection entry point before advertising it.
let inspection;
try {
  execFileSync(path.join(build, "fx-compile"), ["--inspect-lossless", path.join(source, "LICENSE")], { stdio: "pipe", timeout: 10000 });
} catch (error) {
  if (error.status === 1) {
    try { inspection = JSON.parse(String(error.stdout)); } catch {}
  }
}
if (inspection?.schema !== 1 || typeof inspection.error !== "string") throw new Error("The ReShade compiler must support CPU-only model inspection.");
verifyReShadeCompiler(path.join(build, "fx-compile"));
const symbols = execFileSync("/usr/bin/nm", ["-gU", path.join(build, "libreshade-macos.dylib")], { encoding: "utf8" });
if (!/\b_rsProcessFrame\b/.test(symbols)) throw new Error("The ReShade library must provide its shared frame encoder.");
if (!/\b_rsSubmitFramePresenterAtTimeObserved\b/.test(symbols)) throw new Error("The ReShade library must provide frame retirement callbacks for explicit presentation.");
if (features.graphics.browserFrameAPI === 1 && !/\b_rsBrowserFrameAPI\b/.test(symbols)) throw new Error("The ReShade library must provide its completed browser-window frame source.");
if (features.graphics.observedPresentationAPI === 1 && !/\b_rsSubmitFramePresenterObserved\b/.test(symbols)) throw new Error("The ReShade library must provide display-driven frame retirement callbacks.");
if (features.graphics.temporalMethods?.length && !/\b_rsProcessTemporalFrame\b/.test(symbols)) throw new Error("The ReShade library must provide its temporal frame encoder.");
if (features.graphics.temporalCameraAPI === 1) for (const name of ["rsSetTemporalCamera", "rsSetTemporalCameraForTextures", "rsClearTemporalCameraTextures", "rsGetTemporalMethod"])
  if (!new RegExp("\\b_" + name + "\\b").test(symbols)) throw new Error("The graphics library is missing camera input support.");
// The optional DXMT bridge has the selected Windows runtime's own macOS floor.
const floors = nativeFiles.filter(file => !file.startsWith("temporal/dxmt/")&&!optionalLoad.has(file)).flatMap(file =>
  [...execFileSync("xcrun", ["vtool", "-show-build", nativePaths.get(file)], { encoding: "utf8" }).matchAll(/minos\s+(\d+(?:\.\d+)+)/g)].map(match => match[1]));
if (!floors.length) throw new Error("Cannot determine the ReShade macOS requirement.");
const minimumMacOS = floors.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const inputs = new Map([
  ...nativePaths,
  ...retroarchInputs,
  ...optionalInputs,
  ...temporalInputs,
  ["licenses/MacFX.txt", path.join(source, "LICENSE")], ["licenses/THIRD_PARTY.md", path.join(ownedSource, "THIRD_PARTY.md")],
  ["licenses/ReShade.txt", path.join(source, "third_party/reshade/LICENSE.md")],
  ["licenses/MAKO.txt", path.join(source, "third_party/mako/LICENSE.md")],
  ["licenses/FSR1.txt", path.join(source, "third_party/fsr/license.txt")],
  ["licenses/vkd3d.txt", path.join(source, "third_party/vkd3d/COPYING")],
  ["licenses/SPIRV-Cross.txt", path.join(source, "third_party/spirv-cross/LICENSE")],
  ["licenses/SPIRV-Headers.txt", path.join(source, "third_party/reshade/deps/spirv/LICENSE")]
]);
for (const name of ["ReShade.fxh", "ReShadeUI.fxh"]) inputs.set("include/" + name, path.join(source, "third_party/reshade-shaders/Shaders", name));
const effects = path.resolve(import.meta.dirname, "../src/modules/shared/reshade/effects");
for (const name of fs.readdirSync(effects)) inputs.set("effects/" + name, path.join(effects, name));
const effectNotices = validateEffectSources(effectSources, [...inputs].map(([relative, input]) => ({ path: relative, sha256: digest(fs.readFileSync(input)) })));
// Presets, includes and notices belong to the same immutable payload as the
// native binaries. An effect-only update must not overwrite an older version
// while a running game still refers to that version's files.
const payloadHash = digest(Buffer.concat([Buffer.from("adhoc-signature-v1\0" + pins.join("\n") + "\0" + JSON.stringify(features) + "\0" + JSON.stringify(effectSources) + "\0"),
  ...[...extraOwned].flatMap(([relative,file])=>[Buffer.from(relative+'\0'),fs.readFileSync(file)]),
  ...[...inputs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([relative, input]) =>
    [Buffer.from(relative + "\0"), fs.readFileSync(input)])]));
const version = "0.1.0-" + sourceHash.slice(0, 8) + "-" + payloadHash.slice(0, 8);
const directoryRelative = `reshade/${version}/universal`;
const destination = path.join(resourceRoot, directoryRelative);
fs.mkdirSync(destination, { recursive: true });
for (const directory of ["include", "effects", "licenses"]) fs.mkdirSync(path.join(destination, directory), { recursive: true });
const files = [];
for (const [relative, input] of inputs) {
  const output = path.join(destination, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output);
  const executable = nativeFiles.includes(relative);
  fs.chmodSync(output, executable ? 0o755 : 0o644);
  if (executable) execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", output], { stdio: "pipe" });
  files.push({ path: relative, sha256: digest(fs.readFileSync(output)), size: fs.statSync(output).size,
    mode: executable ? 0o755 : 0o644, ...(executable ? { architectures: nativeArchitectures.get(relative),
      ...(relative.startsWith("temporal/dxmt/") ? { executionArchitecture: "x86_64" } : {}),
      ...(optionalLoad.has(relative)?{optionalLoad:optionalLoad.get(relative)}:{}) } : {}) });
}
// The camera provider's source is available in the tagged producer repository.
if (inputs.has('temporal/dxmt/camera-bridge.json')) {
  const relative='temporal/dxmt/camera-bridge.json',file=path.join(destination,relative),metadata=JSON.parse(fs.readFileSync(file));
  delete metadata.files['source.tar.gz'];fs.writeFileSync(file,JSON.stringify(metadata,null,2)+'\n');
  Object.assign(files.find(entry=>entry.path===relative),{sha256:digest(fs.readFileSync(file)),size:fs.statSync(file).size});
}
// Source and owned build recipes are delivered by the tagged producer repository.
function record(relative) {
  const file = path.join(destination, relative); fs.chmodSync(file, 0o644);
  return { path: relative, sha256: digest(fs.readFileSync(file)), size: fs.statSync(file).size, mode: 0o644 };
}
fs.writeFileSync(path.join(destination, "runtime.json"), JSON.stringify({ schema: 1, version,
  minimumMacOS, architectures: ["arm64", "x86_64"], features, effectSources, sourceHash, sourcePins: pins.map(line => line.trim()), files }, null, 2) + "\n");
const manifest = record("runtime.json"); files.push(manifest);
const declaration = { id: "reshade", version, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS,
  sourceRelative: null, sourceSha256: sourceHash, directoryRelative,
  manifestRelative: manifest.path, manifestSha256: manifest.sha256, files,
  notices: [
    { name: "ReShade macOS adapter", license: "BSD-3-Clause", path: "licenses/MacFX.txt" },
    { name: "ReShade", license: "BSD-3-Clause", path: "licenses/ReShade.txt", sourceUrl: "https://github.com/crosire/reshade" },
    { name: "vkd3d shader translator", license: "LGPL-2.1-or-later", path: "licenses/vkd3d.txt", sourceUrl: "https://codeberg.org/vkd3d/vkd3d" },
    { name: "MAKO model processing and frame pacing", license: "GPL-3.0-or-later", path: "licenses/MAKO.txt", sourceUrl: "https://github.com/eugeniosegala/MAKO" },
    { name: "AMD FidelityFX FSR1", license: "MIT", path: "licenses/FSR1.txt", sourceUrl: "https://github.com/GPUOpen-Effects/FidelityFX-FSR" },
    { name: "SPIRV-Cross", license: "Apache-2.0 OR MIT", path: "licenses/SPIRV-Cross.txt", sourceUrl: "https://github.com/KhronosGroup/SPIRV-Cross" },
    { name: "SPIRV-Headers", license: "MIT", path: "licenses/SPIRV-Headers.txt", sourceUrl: "https://github.com/KhronosGroup/SPIRV-Headers" },
    { name: "ReShade shader headers", license: "CC0-1.0", path: "include/ReShade.fxh", sourceUrl: "https://github.com/crosire/reshade-shaders" },
    ...(options["--retroarch"] ? [{name:"librashader",license:"MPL-2.0",path:"notices/librashader/LICENSE.md",sourceUrl:"https://github.com/SnowflakePowered/librashader"}] : []),
    ...(options["--neural"] ? [
      { name: "MLX-DLSS", license: "Apache-2.0", path: "neural/notices/MLX-DLSS-LICENSE", sourceUrl: "https://github.com/iamwavecut/MLX-DLSS" },
      { name: "MLX", license: "MIT", path: "neural/notices/MLX-LICENSE", sourceUrl: "https://github.com/ml-explore/mlx" },
      { name: "MLX Swift", license: "MIT", path: "neural/notices/MLX-Swift-LICENSE", sourceUrl: "https://github.com/ml-explore/mlx-swift" },
      { name: "Swift Argument Parser", license: "Apache-2.0", path: "neural/notices/Swift-Argument-Parser-LICENSE", sourceUrl: "https://github.com/apple/swift-argument-parser" },
      { name: "Swift Numerics", license: "Apache-2.0", path: "neural/notices/Swift-Numerics-LICENSE", sourceUrl: "https://github.com/apple/swift-numerics" }
    ] : []),
    ...(libplacebo?[
      {name:"libplacebo",license:"LGPL-2.1-or-later",path:"notices/libplacebo/libplacebo.360.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>item.name==="libplacebo.360.dylib").source},
      {name:"shaderc",license:"Apache-2.0",path:"notices/libplacebo/libshaderc_shared.1.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>item.name==="libshaderc_shared.1.dylib").source},
      {name:"Little CMS",license:"MIT",path:"notices/libplacebo/liblcms2.2.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>item.name==="liblcms2.2.dylib").source},
      {name:"MoltenVK",license:"Apache-2.0",path:"notices/libplacebo/MoltenVK.LICENSE",sourceUrl:"https://github.com/KhronosGroup/MoltenVK"}
    ]:[]),
    ...(options["--fsr"] ? [
      { name: "AMD FidelityFX FSR2", license: "MIT", path: "temporal/fsr/FSR2-LICENSE.txt", sourceUrl: "https://github.com/GPUOpen-Effects/FidelityFX-FSR2" },
      { name: "AMD FidelityFX FSR3 upscaler", license: "MIT", path: "temporal/fsr/FSR3-LICENSE.txt", sourceUrl: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
    ] : []),
    ...(options["--fsr4"] ? [
      { name: "FSR4 Metal provider", license: "MIT", path: "temporal/fsr4/NOTICE.md", sourceUrl: "https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos" },
      { name: "FSR4 shader implementation", license: "MIT", path: "temporal/fsr4/third_party/fsr411/LICENSE", sourceUrl: "https://github.com/int3rrobang/fsr4-int8-reverse-engineering" },
      { name: "AMD FSR4 model and helpers", license: "MIT", path: "temporal/fsr4/third_party/fsr411/LICENSE.AMD.md", sourceUrl: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
    ] : []),
    ...(options["--godot"] ? [{ name: "Godot extension interface", license: "MIT", path: "godot/GODOT-LICENSE.txt", sourceUrl: "https://github.com/godotengine/godot" }] : []),
    ...(options["--streamline"] ? [{ name: "NVIDIA Streamline interface", license: "MIT", path: "temporal/streamline/Streamline-LICENSE.txt", sourceUrl: "https://github.com/NVIDIA-RTX/Streamline" }] : []),
    ...(options["--dxmt"] ? [
      { name: "DXMT camera integration", license: "LGPL-2.1-or-later", path: "temporal/dxmt/LICENSE", sourceUrl: "https://github.com/3Shain/dxmt" },
      { name: "DXMT Wine interfaces", license: "LGPL-2.1-or-later", path: "temporal/dxmt/COPYING.LIB", sourceUrl: "https://github.com/3Shain/dxmt" },
      { name: "DXMT third-party components", license: "LicenseRef-DXMT-Notices", path: "temporal/dxmt/LICENSE.OLD", sourceUrl: "https://github.com/3Shain/dxmt" }
    ] : []),
    ...effectNotices
  ] };
const { validateDeclaration } = await import("./native-supplementals.cjs");
validateDeclaration(declaration);
fs.writeFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/distribution-supplementals.json"), JSON.stringify([declaration], null, 2) + "\n");
console.log(JSON.stringify({ destination, version, minimumMacOS, files: files.length, sourceHash }));

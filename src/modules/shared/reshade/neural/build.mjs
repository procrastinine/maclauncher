import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {verifyTimingReceipt} from './native/prepare-mlx-timing.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../../../..");
const source = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const restorationArchitectures=createRequire(import.meta.url)('./restoration-models.js').ARCHITECTURES;

const cacheDirectory = path.join(os.homedir(), "Library", "Caches", "maclauncher", "neural-provider");

// With a work directory, SwiftPM builds a copy of the package there, so its
// dependency edit and resolution files never touch the source tree.
export function buildProvider({ work, output = path.join(work || cacheDirectory, "output"),
  sourceDirectory = path.join(repository, "src/external/MLX-DLSS"),
  buildRoot = path.join(work || cacheDirectory, "build"),
  cacheRoot = path.join(work || cacheDirectory, "swiftpm"),
  packageRoot = path.join(work || cacheDirectory, "package") } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("The neural rendering provider build requires Apple Silicon macOS.");
  sourceDirectory = fs.realpathSync(sourceDirectory);
  const revision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== source.commit) throw new Error("The neural rendering source does not match its registered revision.");
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  execFileSync("/bin/bash", [path.join(directory, "native/build.sh"), output], {
    cwd: repository, stdio: "inherit", env: { ...process.env,
      MACLAUNCHER_MLX_DLSS_SOURCE: sourceDirectory,
      MACLAUNCHER_NEURAL_BUILD_ROOT: path.resolve(buildRoot),
      MACLAUNCHER_NEURAL_CACHE_ROOT: path.resolve(cacheRoot),
      MACLAUNCHER_NEURAL_PACKAGE_ROOT: path.resolve(packageRoot) },
  });
  verifyTimingReceipt(JSON.parse(fs.readFileSync(path.join(output,'timing-adaptation.json'))));
  const symbols=execFileSync('nm',['-gU',path.join(output,source.library)],{encoding:'utf8'});
  if(['ml_neural_timing_api','ml_neural_timing_supported_v1','ml_neural_submit_timed_v1','ml_neural_submit_batch_timed_v1'].some(name=>!symbols.includes('_'+name+'\n')))
    throw new Error('The neural provider is missing its GPU timing exports.');
  if(!execFileSync('nm',['-gU',path.join(output,'maclauncher-neural-service')],{encoding:'utf8'}).includes('_ml_neural_service_timing_api\n'))
    throw new Error('The neural helper is missing its GPU timing transport.');
  const files = [source.library, "maclauncher-neural-video", "maclauncher-neural-service", "mlx.metallib", "upstream.json", "adaptation.json",'timing-adaptation.json',
    ...fs.readdirSync(path.join(output, "notices")).sort().map(name => "notices/" + name)].map(relative => {
    const file = path.join(output, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The neural provider requires regular installed files.");
    return { path: relative, size: stat.size, sha256: sha256(file),
      ...([source.library,"maclauncher-neural-service","maclauncher-neural-video"].includes(relative)?{architectures:["arm64"],minimumMacOS:relative==="maclauncher-neural-video"?"26.0":source.minimumMacOS,optionalLoad:true}:{}) };
  });
  for (const name of [source.library, "maclauncher-neural-video", "maclauncher-neural-service"]) {
    const bytes = fs.readFileSync(path.join(output, name));
    if (bytes.includes(Buffer.from(repository)) || bytes.includes(Buffer.from(sourceDirectory)) || bytes.includes(Buffer.from(path.resolve(buildRoot))))
      throw new Error("The neural rendering binary contains a local build path.");
    const architecture = execFileSync("xcrun", ["lipo", "-archs", path.join(output, name)], { encoding: "utf8" }).trim();
    if (architecture !== "arm64") throw new Error("The neural rendering provider must contain an Apple Silicon binary.");
  }
  const descriptor = { providerABI: source.providerABI, commit: source.commit, library: source.library,
    minimumMacOS: source.minimumMacOS, architectures: ["arm64"],supportedABIs:[1,2,3],
    operations:["mlx-dlss","mlx-vsr","mlx-sr-image","mlx-sr-scene","mlx-interpolation","realesrgan","nafnet","realcugan","rife","depth-anything-v2-small"],restorationAPI:1,estimatedDepthAPI:1,gpuTimingAPI:1,
    modelArchitectures:Object.fromEntries([...new Set(Object.values(restorationArchitectures).map(row=>row.method))].map(method=>[method,Object.keys(restorationArchitectures).filter(id=>restorationArchitectures[id].method===method)])),
    service:{executable:"maclauncher-neural-service",architectures:["arm64"],minimumMacOS:source.minimumMacOS,protocol:3},files };
  fs.writeFileSync(path.join(output, "provider.json"), JSON.stringify(descriptor, null, 2) + "\n");
  return { output, descriptor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2), options = {};
  if (arguments_.length === 1 && !arguments_[0].startsWith("--")) options.output = arguments_[0];
  else for (let index = 0; index < arguments_.length; index += 2) {
    const name = { "--output": "output", "--work": "work" }[arguments_[index]];
    if (!name || !arguments_[index + 1] || options[name]) throw new Error("Usage: node build.mjs [--output DIRECTORY] [--work DIRECTORY]");
    options[name] = path.resolve(arguments_[index + 1]);
  }
  const result = buildProvider(options);
  console.log(JSON.stringify({ output: result.output, providerABI: result.descriptor.providerABI,
    commit: result.descriptor.commit, files: result.descriptor.files.length }));
}

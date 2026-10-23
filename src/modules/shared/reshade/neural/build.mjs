import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../../../..");
const source = JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const cacheDirectory = path.join(os.homedir(), "Library", "Caches", "maclauncher", "neural-provider");

export function buildProvider({ output = path.join(cacheDirectory, "output"),
  sourceDirectory = path.join(repository, "src/external/MLX-DLSS"),
  buildRoot = path.join(cacheDirectory, "build"),
  cacheRoot = path.join(cacheDirectory, "swiftpm") } = {}) {
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
      MACLAUNCHER_NEURAL_CACHE_ROOT: path.resolve(cacheRoot) },
  });
  const files = [source.library, "maclauncher-neural-video", "mlx.metallib", "upstream.json", "adaptation.json",
    ...fs.readdirSync(path.join(output, "notices")).sort().map(name => "notices/" + name)].map(relative => {
    const file = path.join(output, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The neural provider requires regular installed files.");
    return { path: relative, size: stat.size, sha256: sha256(file) };
  });
  for (const name of [source.library, "maclauncher-neural-video"]) {
    const bytes = fs.readFileSync(path.join(output, name));
    if (bytes.includes(Buffer.from(repository)) || bytes.includes(Buffer.from(sourceDirectory)) || bytes.includes(Buffer.from(path.resolve(buildRoot))))
      throw new Error("The neural rendering binary contains a local build path.");
    const architecture = execFileSync("xcrun", ["lipo", "-archs", path.join(output, name)], { encoding: "utf8" }).trim();
    if (architecture !== "arm64") throw new Error("The neural rendering provider must contain an Apple Silicon binary.");
  }
  const descriptor = { providerABI: source.providerABI, commit: source.commit, library: source.library,
    minimumMacOS: source.minimumMacOS, architectures: ["arm64"], files };
  fs.writeFileSync(path.join(output, "provider.json"), JSON.stringify(descriptor, null, 2) + "\n");
  return { output, descriptor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  let output;
  if (arguments_.length === 1 && arguments_[0] !== "--output") output = arguments_[0];
  else if (arguments_.length === 2 && arguments_[0] === "--output") output = arguments_[1];
  else if (arguments_.length) throw new Error("Usage: node build.mjs [--output DIRECTORY]");
  const result = buildProvider({ output });
  console.log(JSON.stringify({ output: result.output, providerABI: result.descriptor.providerABI,
    commit: result.descriptor.commit, files: result.descriptor.files.length }));
}

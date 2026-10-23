import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

export const kernelParametersFile = "Sources/DLSSMLX/NeuralRenderingFusedWindowAttention.swift";
export const kernelParametersSourceHash = "188c2cf935b0fc7f2da4100399e0472b8b5290ebf14f749c0349262facef07d7";
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

// Model actors are sequential individually. Their immutable parameter buffers
// are process-wide, so concurrent games and retiring/replacement actors must
// also synchronize cache lookup, creation and publication.
export function patchKernelParameters(source) {
  if (digest(source) !== kernelParametersSourceHash)
    throw new Error("The neural kernel parameter source does not match the pinned adaptation.");
  const original = "  nonisolated(unsafe) private static var cache: [[UInt32]: MLXArray] = [:]\n  static func array(_ values: [UInt32]) -> MLXArray {\n    if let cached = cache[values] { return cached }\n    let created = MLXArray(values)\n    eval(created)\n    cache[values] = created\n    return created\n  }";
  const replacement = "  nonisolated(unsafe) private static var cache: [[UInt32]: MLXArray] = [:]\n  private static let cacheLock = NSLock()\n  static func array(_ values: [UInt32]) -> MLXArray {\n    cacheLock.lock()\n    let cached = cache[values]\n    cacheLock.unlock()\n    if let cached { return cached }\n    // MLX compilation can call here while holding its recursive evaluation lock.\n    // Allocate/evaluate without our lock to avoid reversing that lock order.\n    let created = MLXArray(values)\n    eval(created)\n    cacheLock.lock()\n    defer { cacheLock.unlock() }\n    if let cached = cache[values] { return cached }\n    cache[values] = created\n    return created\n  }";
  if (source.split(original).length !== 2) throw new Error("The neural kernel parameter adaptation is ambiguous.");
  return source.replace(original, replacement);
}

const writeChanged = (file, bytes) => {
  if (!fs.existsSync(file) || !fs.readFileSync(file).equals(Buffer.from(bytes))) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, bytes);
  }
};

export function prepareUpstream(sourceDirectory, buildRoot) {
  sourceDirectory = fs.realpathSync(sourceDirectory);
  const source = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../source.json"), "utf8"));
  const revision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (revision !== source.commit) throw new Error("The neural rendering source does not match its registered revision.");
  const original = fs.readFileSync(path.join(sourceDirectory, kernelParametersFile), "utf8");
  const patched = patchKernelParameters(original);
  const output = path.resolve(buildRoot, "owned-source/MLX-DLSS");
  // Copy only tracked build/source inputs; never modify the checkout or copy
  // its ignored models, compiler caches or workspaces into the owned tree.
  const files = execFileSync("git", ["-C", sourceDirectory, "ls-files", "-z"], {encoding: "utf8"}).split("\0").filter(Boolean);
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("Invalid neural source path.");
    const input = path.join(sourceDirectory, relative), target = path.join(output, relative);
    const stat = fs.lstatSync(input);
    if (!stat.isFile()) throw new Error("The neural provider source requires regular tracked files.");
    writeChanged(target, relative === kernelParametersFile ? patched : fs.readFileSync(input));
  }
  const adaptation = {schema: 1, upstreamCommit: revision, adaptations: [{id: "kernel-parameters-cache-lock-v2",
    file: kernelParametersFile, sourceSha256: kernelParametersSourceHash, appliedSha256: digest(patched)}]};
  writeChanged(path.join(output, "maclauncher-adaptation.json"), JSON.stringify(adaptation, null, 2) + "\n");
  return {output, adaptation};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: prepare-upstream.mjs SOURCE BUILD_ROOT");
  console.log(prepareUpstream(process.argv[2], process.argv[3]).output);
}

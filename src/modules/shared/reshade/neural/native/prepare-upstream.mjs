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

export function patchVideoOperations(source, {restoration = false} = {}) {
  if(digest(source)!=="b7fc48e051da56fa799fa5162b02384006b5061ba4df84c5270d326f8dea84fe")throw new Error("The neural video source does not match its pinned phase adaptation.");
  const anchor="  public func interpolate(_ previous: MLXVideoFrame, _ current: MLXVideoFrame, factor: Int) throws -> [MLXVideoFrame] {";
  if(source.split(anchor).length!==2)throw new Error("The pinned frame-generation phase adapter is ambiguous.");
  const method=`  public func interpolate(_ previous: MLXVideoFrame, _ current: MLXVideoFrame, phases: [Float]) throws -> [MLXVideoFrame] {
    guard !phases.isEmpty, phases.count <= 15, phases.allSatisfy({ $0.isFinite && $0 > 0 && $0 < 1 }) else {
      throw MLXMediaError("Interpolation requires finite phases between zero and one")
    }
    let generated = try generator.interpolationGraph(previous.array, current.array, phases: phases)
    eval(generated)
    return phases.indices.map { MLXVideoFrame(generated[$0..<($0 + 1)]) }
  }

`;
  if(source.split('    command.commit()').length!==2)throw new Error('The pinned GPU pixel writer adaptation is ambiguous.');
  const transformed=source.replace(anchor,method+anchor).replace('    command.commit()','    MLXGPUJob.observe(command)\n    command.commit()');
  return restoration ? transformed.replace("  public func copyRGBData() -> Data {",`  // Tensor-only transform: retains the GPU frame and evaluates on the caller's
  // provider worker without copying frame pixels to host storage.
  public func transformingRGB(_ transform: (MLXArray) throws -> MLXArray) rethrows -> MLXVideoFrame {
    MLXVideoFrame(try transform(array))
  }

  public func transformingRGB(with other: MLXVideoFrame, _ transform: (MLXArray, MLXArray) throws -> MLXArray) rethrows -> MLXVideoFrame {
    MLXVideoFrame(try transform(array, other.array))
  }

  public func copyRGBData() -> Data {`) : transformed;
}

export const opticalFlowFile="Sources/DLSSMedia/NativeOpticalFlow.swift";
export const opticalFlowSourceHash="b2aeed18ae32e67f07ac3d7d2162c41fd8df9cdaeae1d8123fc2806b2aada27e";
export function patchOpticalFlowGPU(source) {
  if(digest(source)!==opticalFlowSourceHash)throw new Error("The optical-flow source does not match its pinned GPU adaptation.");
  const anchor="    request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float\n";
  if(source.split(anchor).length!==2)throw new Error("The optical-flow GPU adaptation is ambiguous.");
  return source.replace("import CoreMedia\n","import CoreMedia\nimport CoreML\n").replace(anchor,anchor+`    let supported = try request.supportedComputeStageDevices
    for (stage, devices) in supported {
      guard let gpu = devices.first(where: { if case .gpu = $0 { return true }; return false }) else {
        throw MLXMediaError("GPU optical flow is unavailable for this compute stage")
      }
      request.setComputeDevice(gpu, for: stage)
    }
`);
}

export const sceneSRFile="Sources/DLSSMLX/DLSSSuperResolution.swift";
export const sceneSRSourceHash="b448d95bd90a8e45287bdf7da3bcb51c175d02aeb9e9a7bb5209523cf33d923a";
export function patchSceneSR(source) {
  if(digest(source)!==sceneSRSourceHash)throw new Error("The DLSS SR source does not match its pinned scene-guide adaptation.");
  const signature="  public func upscale(_ rgb: MLXArray, motion: MLXArray? = nil, reset: Bool = false) throws";
  const depth="    let depth = MLXArray.full([h, w, 4], values: MLXArray(Float(0.5)))";
  const anchor="  public func reset() { model.reset() }";
  for(const item of [signature,depth,anchor])if(source.split(item).length!==2)throw new Error("The pinned DLSS scene-guide adaptation is ambiguous.");
  return source.replace("import CryptoKit\n","import CryptoKit\nimport CoreVideo\n")
    .replace(signature,"  public func upscale(_ rgb: MLXArray, motion: MLXArray? = nil, reset: Bool = false, sceneDepth: MLXArray? = nil) throws")
    .replace(depth,`    if let sceneDepth {
      guard sceneDepth.shape == [h,w,4], sceneDepth.dtype == .float32 else {
        throw MLXMediaError("Scene depth requires input-size floating-point guides")
      }
    }
    let depth = sceneDepth ?? MLXArray.full([h, w, 4], values: MLXArray(Float(0.5)))`)
    .replace(anchor,anchor+`
  // The caller canonicalizes jitter, vector units and pre-exposure on Metal.
  // RG contain actual current-to-previous input-pixel motion; B contains the
  // same scene's near-to-far depth. The IOSurface remains GPU backed throughout.
  public func upscaleScene(_ frame: MLXVideoFrame, guides: MLXPixelBuffer, reset: Bool) throws -> MLXVideoFrame {
    guard CVPixelBufferGetPixelFormatType(guides.buffer) == kCVPixelFormatType_128RGBAFloat,
      guides.width == frame.width, guides.height == frame.height else {
      throw MLXMediaError("Scene SR requires matching RGBA32F motion/depth guides")
    }
    let storage = try MLXVideoFrame.storage(guides.buffer,dtype: .float32)
    let shape = MLXArray([UInt32(frame.width),UInt32(frame.height),UInt32(CVPixelBufferGetBytesPerRow(guides.buffer)/4)])
    let imported = Self.importScene([storage,shape],grid: (frame.width*frame.height,1,1),threadGroup: (256,1,1),
      outputShapes: [[1,frame.height,frame.width,2],[frame.height,frame.width,4]],outputDTypes: [.float32,.float32])
    return MLXVideoFrame(try model.upscale(frame.array,motion: imported[0],reset: reset,sceneDepth: imported[1]))
  }
  private static let importScene = MLXFast.metalKernel(name: "mlxdlss_scene_guides_v1",inputNames: ["pixels","shape"],outputNames: ["motion","depth"],source: #"""
    uint i=thread_position_in_grid.x;if(i>=shape[0]*shape[1])return;
    uint x=i%shape[0],y=i/shape[0],at=y*shape[2]+x*4;
    motion[i*2]=float(pixels[at]);motion[i*2+1]=float(pixels[at+1]);
    float z=float(pixels[at+2]);for(uint c=0;c<4;++c)depth[i*4+c]=z;
    """#)
`);
}

export function prepareUpstream(sourceDirectory, buildRoot) {
  sourceDirectory = fs.realpathSync(sourceDirectory);
  const source = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../source.json"), "utf8"));
  const revision = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (revision !== source.commit) throw new Error("The neural rendering source does not match its registered revision.");
  const original = fs.readFileSync(path.join(sourceDirectory, kernelParametersFile), "utf8");
  const patched = patchKernelParameters(original);
  const videoFile="Sources/DLSSMLX/MLXVideoFrame.swift",videoOriginal=fs.readFileSync(path.join(sourceDirectory,videoFile),"utf8"),videoPatched=patchVideoOperations(videoOriginal,{restoration:true});
  const flowOriginal=fs.readFileSync(path.join(sourceDirectory,opticalFlowFile),"utf8"),flowPatched=patchOpticalFlowGPU(flowOriginal);
  const sceneOriginal=fs.readFileSync(path.join(sourceDirectory,sceneSRFile),"utf8"),scenePatched=patchSceneSR(sceneOriginal);
  const output = path.resolve(buildRoot, "owned-source/MLX-DLSS");
  // Copy only tracked build/source inputs; never modify the checkout or copy
  // its ignored models, compiler caches or workspaces into the owned tree.
  const files = execFileSync("git", ["-C", sourceDirectory, "ls-files", "-z"], {encoding: "utf8"}).split("\0").filter(Boolean);
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("Invalid neural source path.");
    const input = path.join(sourceDirectory, relative), target = path.join(output, relative);
    const stat = fs.lstatSync(input);
    if (!stat.isFile()) throw new Error("The neural provider source requires regular tracked files.");
    writeChanged(target, relative === kernelParametersFile ? patched : relative===videoFile?videoPatched:relative===opticalFlowFile?flowPatched:relative===sceneSRFile?scenePatched:fs.readFileSync(input));
  }
  const adaptation = {schema: 1, upstreamCommit: revision, adaptations: [{id: "kernel-parameters-cache-lock-v2",
    file: kernelParametersFile, sourceSha256: kernelParametersSourceHash, appliedSha256: digest(patched)},
    {id:"video-operations-rgb-transform-v2",file:videoFile,sourceSha256:digest(videoOriginal),appliedSha256:digest(videoPatched)},
    {id:"optical-flow-gpu-stages-v1",file:opticalFlowFile,sourceSha256:opticalFlowSourceHash,appliedSha256:digest(flowPatched)},
    {id:"dlss-sr-scene-guides-v1",file:sceneSRFile,sourceSha256:sceneSRSourceHash,appliedSha256:digest(scenePatched)}]};
  writeChanged(path.join(output, "maclauncher-adaptation.json"), JSON.stringify(adaptation, null, 2) + "\n");
  return {output, adaptation};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: prepare-upstream.mjs SOURCE BUILD_ROOT");
  console.log(prepareUpstream(process.argv[2], process.argv[3]).output);
}

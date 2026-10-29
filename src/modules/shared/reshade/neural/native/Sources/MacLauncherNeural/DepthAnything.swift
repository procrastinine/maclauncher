// Copyright (c) MacLauncher contributors. MIT license.
// Depth Anything V2 and DINOv2: Apache-2.0. Exact original graph/checkpoint
// identities accompany depth-anything-source.json and the original notices.
import Cmlx
import CoreVideo
import Foundation
import IOSurface
import Metal
import MLX
import MLXNN

struct DepthModelError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// Tensor-only DINOv2 ViT-S/14 + original DPT64 head. Output is raw inferred
/// relative inverse depth, not metres or renderer-visible/hidden geometry.
final class DepthAnythingV2: @unchecked Sendable {
  static let architecture = "depth-anything-v2.vits.relative.v1"
  let weights: [String: MLXArray]
  private var positions: [String: MLXArray] = [:]

  static let shapes: [String: [Int]] = {
    var values: [String: [Int]] = [:]
    func pair(_ name: String, _ shape: [Int]) {
      values[name + ".weight"] = shape
      values[name + ".bias"] = [shape[0]]
    }
    values["backbone.embeddings.cls_token"] = [1, 1, 384]
    values["backbone.embeddings.mask_token"] = [1, 384]
    pair("backbone.embeddings.patch_embeddings.projection", [384, 3, 14, 14])
    values["backbone.embeddings.position_embeddings"] = [1, 1370, 384]
    for index in 0..<12 {
      let prefix = "backbone.encoder.layer.\(index)"
      for name in ["query", "key", "value"] {
        pair(prefix + ".attention.attention." + name, [384, 384])
      }
      pair(prefix + ".attention.output.dense", [384, 384])
      for name in ["layer_scale1", "layer_scale2"] { values[prefix + "." + name + ".lambda1"] = [384] }
      pair(prefix + ".mlp.fc1", [1536, 384]); pair(prefix + ".mlp.fc2", [384, 1536])
      pair(prefix + ".norm1", [384]); pair(prefix + ".norm2", [384])
    }
    pair("backbone.layernorm", [384])
    for (index, channels) in [48, 96, 192, 384].enumerated() {
      let prefix = "neck.reassemble_stage.layers.\(index)"
      pair(prefix + ".projection", [channels, 384, 1, 1])
      if index != 2 {
        let size = index == 0 ? 4 : index == 1 ? 2 : 3
        pair(prefix + ".resize", [channels, channels, size, size])
      }
      values["neck.convs.\(index).weight"] = [64, channels, 3, 3]
      let fusion = "neck.fusion_stage.layers.\(index)"
      pair(fusion + ".projection", [64, 64, 1, 1])
      for residual in 1...2 {
        for convolution in 1...2 {
          pair(fusion + ".residual_layer\(residual).convolution\(convolution)", [64, 64, 3, 3])
        }
      }
    }
    pair("head.conv1", [32, 64, 3, 3]); pair("head.conv2", [32, 32, 3, 3]); pair("head.conv3", [1, 32, 1, 1])
    return values
  }()

  init(modelURL: URL) throws {
    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: modelURL.appendingPathComponent("manifest.json"))) as? [String: Any]
    guard manifest?["architecture"] as? String == Self.architecture,
      let record = manifest?["weights"] as? [String: Any], let file = record["file"] as? String,
      !file.isEmpty, URL(fileURLWithPath: file).lastPathComponent == file else {
      throw DepthModelError(message: "Choose the supported Depth Anything V2 Small relative-depth model")
    }
    let values = try loadArrays(url: modelURL.appendingPathComponent(file), stream: .cpu)
    guard Set(values.keys) == Set(Self.shapes.keys), Self.shapes.allSatisfy({ name, shape in
      values[name]?.shape == shape && [.float16, .float32].contains(values[name]!.dtype)
    }) else {
      throw DepthModelError(message: "Depth estimation requires the exact ViT-S/14 and DPT64 tensor contract")
    }
    var prepared: [String: MLXArray] = [:]
    for (name, original) in values {
      let value = original.asType(name == "backbone.embeddings.position_embeddings" ? .float32 : .float16)
      if original.ndim == 4 {
        let transpose = name == "neck.reassemble_stage.layers.0.resize.weight" || name == "neck.reassemble_stage.layers.1.resize.weight"
        // Ordinary kernels are OIHW. The two transposed kernels are IOHW.
        prepared[name] = contiguous(transpose ? value.transposed(1, 2, 3, 0) : value.transposed(0, 2, 3, 1))
      } else { prepared[name] = value }
    }
    weights = prepared
    eval(Array(prepared.values))
    guard stacked(prepared.values.map { isFinite($0).all() }).all().item(Bool.self) else {
      throw DepthModelError(message: "Depth model parameters must remain finite in their GPU inference precision")
    }
  }

  private func convolution(_ name: String, _ input: MLXArray, stride: Int = 1, padding: Int = 1, transpose: Bool = false) -> MLXArray {
    let weight = weights[name + ".weight"]!
    let value = transpose
      ? convTransposed2d(input, weight, stride: IntOrPair(stride), padding: IntOrPair(padding))
      : conv2d(input, weight, stride: IntOrPair(stride), padding: IntOrPair(padding))
    return weights[name + ".bias"].map { value + $0 } ?? value
  }
  private func linear(_ name: String, _ input: MLXArray) -> MLXArray {
    matmul(input, weights[name + ".weight"]!.transposed()) + weights[name + ".bias"]!
  }
  private func norm(_ name: String, _ input: MLXArray) -> MLXArray {
    MLXFast.layerNorm(input, weight: weights[name + ".weight"], bias: weights[name + ".bias"], eps: 1e-6)
  }
  private func positionEmbedding(height: Int, width: Int) -> MLXArray {
    let key = "\(height)x\(width)"
    if let value = positions[key] { return value }
    let original = weights["backbone.embeddings.position_embeddings"]!
    let result: MLXArray
    if height == 37 && width == 37 { result = original.asType(.float16) }
    else {
      let patches = original[0..., 1..<1370, 0...].reshaped([1, 37, 37, 384])
      // DINO's scale-factor interpolation uses +0.1 before division by37.
      // Replacing it with a plain target-size resize changes sample positions.
      let resized = DepthTensorResize.resize(patches, height: height, width: width, cubic: true,
        scaleX: 37 / (Float(width) + 0.1), scaleY: 37 / (Float(height) + 0.1))
      result = concatenated([original[0..., 0..<1, 0...], resized.reshaped([1, height * width, 384])], axis: 1).asType(.float16)
    }
    if positions.count >= 2 { positions.removeAll(keepingCapacity: true) }
    positions[key] = result
    return result
  }
  private func transformer(_ input: MLXArray, index: Int) -> MLXArray {
    let prefix = "backbone.encoder.layer.\(index)", count = input.dim(1)
    let normalized = norm(prefix + ".norm1", input)
    func projection(_ name: String) -> MLXArray {
      linear(prefix + ".attention.attention." + name, normalized).reshaped([1, count, 6, 64]).transposed(0, 2, 1, 3)
    }
    let attention = MLXFast.scaledDotProductAttention(queries: projection("query"), keys: projection("key"),
      values: projection("value"), scale: 0.125, mask: nil).transposed(0, 2, 1, 3).reshaped([1, count, 384])
    let value = input + linear(prefix + ".attention.output.dense", attention) * weights[prefix + ".layer_scale1.lambda1"]!
    let hidden = gelu(linear(prefix + ".mlp.fc1", norm(prefix + ".norm2", value)))
    return value + linear(prefix + ".mlp.fc2", hidden) * weights[prefix + ".layer_scale2.lambda1"]!
  }
  private func residual(_ input: MLXArray, name: String) -> MLXArray {
    let first = convolution(name + ".convolution1", maximum(input, 0))
    return input + convolution(name + ".convolution2", maximum(first, 0))
  }
  private func fusion(_ input: MLXArray, residual other: MLXArray?, index: Int, height: Int, width: Int) -> MLXArray {
    let prefix = "neck.fusion_stage.layers.\(index)"
    var value = input
    if let other {
      let aligned = other.shape == input.shape ? other : DepthTensorResize.resize(other, height: input.dim(1), width: input.dim(2))
      value = value + residual(aligned, name: prefix + ".residual_layer1")
    }
    value = residual(value, name: prefix + ".residual_layer2")
    value = DepthTensorResize.resize(value, height: height, width: width, alignCorners: true)
    return convolution(prefix + ".projection", value, padding: 0)
  }

  func callAsFunction(_ normalizedRGB: MLXArray) -> MLXArray {
    precondition(normalizedRGB.ndim == 4 && normalizedRGB.dim(0) == 1 && normalizedRGB.dim(3) == 3)
    let height = normalizedRGB.dim(1), width = normalizedRGB.dim(2), patchH = height / 14, patchW = width / 14
    precondition(height > 0 && width > 0 && height % 14 == 0 && width % 14 == 0)
    var value = convolution("backbone.embeddings.patch_embeddings.projection", normalizedRGB.asType(.float16), stride: 14, padding: 0).reshaped([1, patchH * patchW, 384])
    value = concatenated([weights["backbone.embeddings.cls_token"]!, value], axis: 1) + positionEmbedding(height: patchH, width: patchW)
    var features: [MLXArray] = []
    for index in 0..<12 {
      value = transformer(value, index: index)
      if [2, 5, 8, 11].contains(index) {
        features.append(norm("backbone.layernorm", value)[0..., 1..<(patchH * patchW + 1), 0...].reshaped([1, patchH, patchW, 384]))
      }
    }
    var layers: [MLXArray] = []
    for index in 0..<4 {
      let prefix = "neck.reassemble_stage.layers.\(index)"
      var layer = convolution(prefix + ".projection", features[index], padding: 0)
      if index < 2 { layer = convolution(prefix + ".resize", layer, stride: index == 0 ? 4 : 2, padding: 0, transpose: true) }
      else if index == 3 { layer = convolution(prefix + ".resize", layer, stride: 2) }
      layers.append(convolution("neck.convs.\(index)", layer))
    }
    var fused = fusion(layers[3], residual: nil, index: 0, height: layers[2].dim(1), width: layers[2].dim(2))
    for index in 1..<4 {
      let next = index < 3 ? layers[2 - index] : nil
      fused = fusion(fused, residual: layers[3 - index], index: index,
        height: next?.dim(1) ?? fused.dim(1) * 2, width: next?.dim(2) ?? fused.dim(2) * 2)
    }
    var output = convolution("head.conv1", fused)
    output = DepthTensorResize.resize(output, height: height, width: width, alignCorners: true)
    output = maximum(convolution("head.conv2", output), 0)
    return maximum(convolution("head.conv3", output, padding: 0), 0).asType(.float32)
  }
}

/// Exact per-axis coordinate rules for PyTorch align-corners bilinear and
/// OpenCV/PyTorch -0.75 bicubic interpolation. Every sample remains on the GPU.
enum DepthTensorResize {
  static func resize(_ input: MLXArray, height: Int, width: Int, alignCorners: Bool = false,
    cubic: Bool = false, scaleX: Float? = nil, scaleY: Float? = nil) -> MLXArray {
    if input.dim(1) == height && input.dim(2) == width && scaleX == nil && scaleY == nil { return input }
    let x = scaleX ?? (alignCorners ? width > 1 ? Float(input.dim(2) - 1) / Float(width - 1) : 0 : Float(input.dim(2)) / Float(width))
    let y = scaleY ?? (alignCorners ? height > 1 ? Float(input.dim(1) - 1) / Float(height - 1) : 0 : Float(input.dim(1)) / Float(height))
    let dimensions = MLXArray([UInt32(input.dim(2)), UInt32(input.dim(1)), UInt32(input.dim(3)), UInt32(width), UInt32(height)])
    return kernel([contiguous(input), dimensions, MLXArray([x, y])], template: [("cubic", cubic), ("alignCorners", alignCorners)],
      grid: (width * height * input.dim(3), 1, 1), threadGroup: (256, 1, 1),
      outputShapes: [[1, height, width, input.dim(3)]], outputDTypes: [input.dtype])[0]
  }
  private static let kernel = MLXFast.metalKernel(name: "maclauncher_depth_resize", inputNames: ["image", "dimensions", "scales"], outputNames: ["output"],
    source: #"""
      uint i=thread_position_in_grid.x,sw=dimensions[0],sh=dimensions[1],channels=dimensions[2],width=dimensions[3],height=dimensions[4];
      if(i>=width*height*channels)return;
      uint c=i%channels,x=(i/channels)%width,y=i/(channels*width);
      float sx=alignCorners?x*scales[0]:(x+.5f)*scales[0]-.5f,sy=alignCorners?y*scales[1]:(y+.5f)*scales[1]-.5f;
      int bx=int(floor(sx)),by=int(floor(sy));float sum=0;
      if(cubic){for(int dy=-1;dy<=2;++dy)for(int dx=-1;dx<=2;++dx){int px=clamp(bx+dx,0,int(sw)-1),py=clamp(by+dy,0,int(sh)-1);sum+=float(image[(py*sw+px)*channels+c])*depth_cubic(sx-(bx+dx))*depth_cubic(sy-(by+dy));}}
      else{float fx=sx-bx,fy=sy-by;for(int dy=0;dy<=1;++dy)for(int dx=0;dx<=1;++dx){int px=clamp(bx+dx,0,int(sw)-1),py=clamp(by+dy,0,int(sh)-1);sum+=float(image[(py*sw+px)*channels+c])*(dx?fx:1-fx)*(dy?fy:1-fy);}}
      output[i]=sum;
      """#, header: #"""
      float depth_cubic(float v){v=abs(v);return v<=1?((1.25f*v-2.25f)*v)*v+1:v<2?((-.75f*v+3.75f)*v-6)*v+3:0;}
      """#)
}

/// Full-image RGB proxy -> preprocessed network grid -> raw R32 IOSurface.
/// Managed MLX/Metal buffers share the GPU pages; CPU handles metadata only.
final class DepthPixelIO: @unchecked Sendable {
  let device: any MTLDevice
  let queue: any MTLCommandQueue
  let pipeline: any MTLComputePipelineState
  init(device: any MTLDevice) throws {
    self.device = device
    guard let queue = device.makeCommandQueue() else { throw DepthModelError(message: "Depth GPU commands are unavailable") }
    self.queue = queue
    let library = try device.makeLibrary(source: """
      #include <metal_stdlib>
      using namespace metal;
      kernel void depth_publish(device const float*value[[buffer(0)]],texture2d<float,access::write>target[[texture(0)]],device atomic_uint&invalid[[buffer(1)]],uint2 p[[thread_position_in_grid]]){
        if(p.x>=target.get_width()||p.y>=target.get_height())return;float v=value[p.y*target.get_width()+p.x];if(!isfinite(v)||v<0){atomic_fetch_add_explicit(&invalid,1,memory_order_relaxed);v=0;}target.write(float4(v,0,0,1),p);
      }
      """, options: nil)
    guard let function = library.makeFunction(name: "depth_publish") else { throw DepthModelError(message: "Depth GPU publication is unavailable") }
    pipeline = try device.makeComputePipelineState(function: function)
  }
  static func preprocess(_ bytes: MLXArray, sourceWidth: Int, sourceHeight: Int, stride: Int, width: Int, height: Int) -> MLXArray {
    let dimensions = MLXArray([UInt32(sourceWidth), UInt32(sourceHeight), UInt32(stride), UInt32(width), UInt32(height)])
    return importRGB([bytes, dimensions], grid: (width * height * 3, 1, 1), threadGroup: (256, 1, 1),
      outputShapes: [[1, height, width, 3]], outputDTypes: [.float32])[0]
  }
  func warm(_ model: DepthAnythingV2, width: Int, height: Int) throws {
    let pixels = MLXArray.zeros([width * height * 4], dtype: .uint8)
    let input = Self.preprocess(pixels, sourceWidth: width, sourceHeight: height, stride: width * 4, width: width, height: height)
    let output = model(input)
    eval(output)
    guard isFinite(output).all().item(Bool.self) else { throw DepthModelError(message: "Depth model preparation produced nonfinite scalar data") }
  }
  func render(_ model: DepthAnythingV2, source: CVPixelBuffer, destination: CVPixelBuffer) async throws {
    guard CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA,
      CVPixelBufferGetPixelFormatType(destination) == kCVPixelFormatType_OneComponent32Float,
      !CVPixelBufferIsPlanar(source), !CVPixelBufferIsPlanar(destination),
      let sourceSurface = CVPixelBufferGetIOSurface(source)?.takeUnretainedValue(),
      let destinationSurface = CVPixelBufferGetIOSurface(destination)?.takeUnretainedValue() else {
      throw DepthModelError(message: "Depth estimation requires BGRA8 input and raw R32Float IOSurface output")
    }
    let width = CVPixelBufferGetWidth(destination), height = CVPixelBufferGetHeight(destination)
    guard width > 0, height > 0, width % 14 == 0, height % 14 == 0,
      CVPixelBufferGetDataSize(source) < Int(Int32.max) else { throw DepthModelError(message: "Depth input grid must use positive multiples of fourteen") }
    let owner = Unmanaged.passRetained(source).toOpaque()
    var count = [Int32(CVPixelBufferGetBytesPerRow(source) * CVPixelBufferGetHeight(source))]
    let bytes = MLXArray(mlx_array_new_data_managed_payload(IOSurfaceGetBaseAddress(sourceSurface), &count, 1, MLX_UINT8, owner) { payload in
      if let payload { Unmanaged<CVPixelBuffer>.fromOpaque(payload).release() }
    })
    let input = Self.preprocess(bytes, sourceWidth: CVPixelBufferGetWidth(source), sourceHeight: CVPixelBufferGetHeight(source),
      stride: CVPixelBufferGetBytesPerRow(source), width: width, height: height)
    let depth = contiguous(model(input))
    eval(depth)
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float, width: width, height: height, mipmapped: false)
    descriptor.storageMode = .shared; descriptor.usage = [.shaderRead, .shaderWrite]
    guard let texture = device.makeTexture(descriptor: descriptor, iosurface: destinationSurface, plane: 0),
      let buffer = depth.asMTLBuffer(device: device, noCopy: true), let invalid = device.makeBuffer(length: 4, options: .storageModeShared),
      let commands = queue.makeCommandBuffer(), let encoder = commands.makeComputeCommandEncoder() else {
      throw DepthModelError(message: "Cannot bind scalar depth GPU storage")
    }
    invalid.contents().storeBytes(of: UInt32(0), as: UInt32.self)
    encoder.setComputePipelineState(pipeline); encoder.setTexture(texture, index: 0)
    encoder.setBuffer(buffer, offset: 0, index: 0); encoder.setBuffer(invalid, offset: 0, index: 1)
    encoder.dispatchThreads(.init(width: width, height: height, depth: 1), threadsPerThreadgroup: .init(width: 8, height: 8, depth: 1))
    encoder.endEncoding()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      commands.addCompletedHandler { [depth, source, destination] completed in
        withExtendedLifetime((depth, source, destination)) {
          if let error = completed.error { continuation.resume(throwing: error) }
          else if invalid.contents().load(as: UInt32.self) != 0 { continuation.resume(throwing: DepthModelError(message: "Depth model produced nonfinite or negative scalar data")) }
          else { continuation.resume() }
        }
      }
      MLXGPUJob.observe(commands)
      commands.commit()
    }
  }
  private static let importRGB = MLXFast.metalKernel(name: "maclauncher_depth_import", inputNames: ["pixels", "dimensions"], outputNames: ["rgb"],
    source: #"""
      uint i=thread_position_in_grid.x,sw=dimensions[0],sh=dimensions[1],stride=dimensions[2],width=dimensions[3],height=dimensions[4];if(i>=width*height*3)return;
      uint c=i%3,x=(i/3)%width,y=i/(3*width);float sx=(x+.5f)*float(sw)/width-.5f,sy=(y+.5f)*float(sh)/height-.5f;
      int bx=int(floor(sx)),by=int(floor(sy));float sum=0;
      for(int dy=-1;dy<=2;++dy)for(int dx=-1;dx<=2;++dx){int px=clamp(bx+dx,0,int(sw)-1),py=clamp(by+dy,0,int(sh)-1);sum+=float(pixels[py*stride+px*4+2-c])*(1.f/255)*depth_cubic(sx-(bx+dx))*depth_cubic(sy-(by+dy));}
      const float means[3]={.485f,.456f,.406f},deviations[3]={.229f,.224f,.225f};rgb[i]=(sum-means[c])/deviations[c];
      """#, header: #"""
      float depth_cubic(float v){v=abs(v);return v<=1?((1.25f*v-2.25f)*v)*v+1:v<2?((-.75f*v+3.75f)*v-6)*v+3:0;}
      """#)
}

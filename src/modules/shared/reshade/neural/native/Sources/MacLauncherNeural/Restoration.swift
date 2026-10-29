// Copyright (c) MacLauncher contributors. MIT license.
// SRVGG architecture: Real-ESRGAN, Copyright 2021 Xintao Wang, BSD-3-Clause.
// Exact source identities and original notices accompany restoration-sources.json.
import Foundation
import MLX

struct RestorationError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// NHWC tensor-only graph. IOSurface import and GPU packing stay in the shared
/// video-frame bridge; this graph never obtains CPU image storage.
final class SRVGGRestoration: @unchecked Sendable {
  let depth: Int
  private(set) var weights: [String: MLXArray]
  static func shapes(depth: Int) -> [String: [Int]] {
    var result: [String: [Int]] = [:]
    for index in 0...depth {
      result["body.\(index * 2).weight"] = [64, 3, 3, index == 0 ? 3 : 64]
      result["body.\(index * 2).bias"] = [64]
      result["body.\(index * 2 + 1).weight"] = [64]
    }
    result["body.\(depth * 2 + 2).weight"] = [48, 3, 3, 64]
    result["body.\(depth * 2 + 2).bias"] = [48]
    return result
  }
  convenience init(modelURL: URL, denoise: Float) throws {
    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: modelURL.appendingPathComponent("manifest.json"))) as? [String: Any]
    guard let architecture = manifest?["architecture"] as? String,
      ["realesrgan.srvgg-16.x4.v1", "realesrgan.srvgg-32.x4.v1"].contains(architecture),
      denoise.isFinite, (0...1).contains(denoise),
      let record = manifest?["weights"] as? [String: Any], let file = record["file"] as? String,
      URL(fileURLWithPath: file).lastPathComponent == file else {
      throw RestorationError(message: "Choose compatible Real-ESRGAN SRVGG 4× weights")
    }
    let depth = architecture.contains("-16.") ? 16 : 32
    let main = try loadArrays(url: modelURL.appendingPathComponent(file), stream: .cpu)
    var weak: [String: MLXArray]?
    if let companion = manifest?["denoiseWeights"] as? [String: Any] {
      guard depth == 32, let name = companion["file"] as? String,
        URL(fileURLWithPath: name).lastPathComponent == name else {
        throw RestorationError(message: "WDN blending requires the paired general SRVGG-32 checkpoint")
      }
      weak = try loadArrays(url: modelURL.appendingPathComponent(name), stream: .cpu)
    }
    try self.init(depth: depth, weights: main, weakWeights: weak, denoise: denoise)
  }
  init(depth: Int, weights source: [String: MLXArray], weakWeights: [String: MLXArray]? = nil, denoise: Float = 1) throws {
    guard [16, 32].contains(depth), denoise.isFinite, (0...1).contains(denoise) else {
      throw RestorationError(message: "Unsupported SRVGG configuration")
    }
    let shapes = Self.shapes(depth: depth)
    func valid(_ values: [String: MLXArray]) -> Bool {
      Set(values.keys) == Set(shapes.keys) && shapes.allSatisfy { name, shape in
        values[name]?.shape == shape && [DType.float16, .float32].contains(values[name]!.dtype)
      }
    }
    guard valid(source), weakWeights.map(valid) ?? true, weakWeights == nil || depth == 32 else {
      throw RestorationError(message: "The SRVGG tensor names, layouts or trained depth do not match")
    }
    self.depth = depth
    // Original DNI semantics: 0 retains weakly denoised detail; 1 selects the
    // strong general checkpoint. Interpolate every matching trained parameter.
    weights = source.mapValues { $0.asType(.float32) }
    if let weakWeights {
      weights = Dictionary(uniqueKeysWithValues: source.map { name, value in
        (name, value.asType(.float32) * denoise + weakWeights[name]!.asType(.float32) * (1 - denoise))
      })
    }
    eval(Array(weights.values))
  }
  func callAsFunction(_ input: MLXArray) -> MLXArray {
    var value = input
    for index in 0...depth {
      value = conv2d(value, weights["body.\(index * 2).weight"]!, padding: 1) + weights["body.\(index * 2).bias"]!
      value = maximum(value, 0) + weights["body.\(index * 2 + 1).weight"]! * minimum(value, 0)
    }
    value = conv2d(value, weights["body.\(depth * 2 + 2).weight"]!, padding: 1) + weights["body.\(depth * 2 + 2).bias"]!
    let s = input.shape
    // PyTorch channel order is C,r,r, not r,r,C.
    value = value.reshaped([s[0], s[1], s[2], 3, 4, 4]).transposed(0, 1, 4, 2, 5, 3).reshaped([s[0], s[1] * 4, s[2] * 4, 3])
    let nearest = MLXArray.repeated(MLXArray.repeated(input, count: 4, axis: 1), count: 4, axis: 2)
    return value + nearest
  }
}

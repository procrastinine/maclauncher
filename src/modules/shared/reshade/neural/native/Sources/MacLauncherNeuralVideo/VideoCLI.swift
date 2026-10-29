import Darwin
import DLSSMedia
import Foundation

private struct Arguments {
  var values: [String: String] = [:]
  init(_ arguments: [String]) throws {
    var index = 0
    let allowed: Set<String> = ["--input", "--output", "--model", "--intensity", "--temporal",
      "--codec", "--processing-scale", "--detail-strength", "--colour-strength", "--frames", "--method", "--frame-factor"]
    while index < arguments.count {
      let key = arguments[index]
      guard allowed.contains(key), index + 1 < arguments.count, values[key] == nil else {
        throw CLIError(message: "Invalid or duplicate video-processing option: \(key)")
      }
      values[key] = arguments[index + 1]
      index += 2
    }
    for key in ["--input", "--output", "--model"] where values[key]?.isEmpty != false {
      throw CLIError(message: "Missing video-processing option: \(key)")
    }
  }
  func float(_ key: String, default fallback: Float) throws -> Float {
    guard let text = values[key] else { return fallback }
    guard let value = Float(text), value.isFinite else {
      throw CLIError(message: "Invalid numeric video-processing option: \(key)")
    }
    return value
  }
}

private struct CLIError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

@MainActor private func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    var line = String(data: data, encoding: .utf8) else { return }
  line.append("\n")
  FileHandle.standardOutput.write(Data(line.utf8))
}

@main struct MacLauncherNeuralVideo {
  @MainActor static func main() async {
    if CommandLine.arguments.dropFirst().contains("--help") {
      print("maclauncher-neural-video --input FILE --output NEW_FILE --model MODEL.dlssmodel [--intensity 0...2] [--temporal on|off] [--codec h264|hevc|prores] [--processing-scale 1...4] [--detail-strength 0...8] [--colour-strength 0...4] [--frames COUNT]")
      return
    }
    guard #available(macOS 26.0, *) else {
      emit(["type": "error", "message": "Offline neural video processing requires macOS 26 or later"])
      exit(1)
    }
    do {
      let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
      let input = URL(fileURLWithPath: arguments.values["--input"]!)
      let output = URL(fileURLWithPath: arguments.values["--output"]!)
      let model = URL(fileURLWithPath: arguments.values["--model"]!, isDirectory: true)
      guard input.standardizedFileURL != output.standardizedFileURL else {
        throw CLIError(message: "Choose a new output file for processed video")
      }
      guard !FileManager.default.fileExists(atPath: output.path) else {
        throw CLIError(message: "The output video already exists")
      }
      let method = arguments.values["--method"] ?? "mlx-dlss"
      var options = MediaProcessingOptions()
      if method == "mlx-dlss" { options.renderingModel = model }
      else if method == "mlx-sr-image" { options.dlssSuperResolutionModel = model }
      else if method == "mlx-vsr" || method == "mlx-interpolation" {
        guard let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: model.appendingPathComponent("manifest.json"))) as? [String: Any],
          manifest["architecture"] as? String == (method == "mlx-vsr" ? "mlxdlss.rtx-vsr-1.8.2.mode16.v1" : "mlxdlss.video-frame-generation.v1"),
          let weights = manifest["weights"] as? [String: Any], let file = weights["file"] as? String,
          URL(fileURLWithPath: file).lastPathComponent == file else { throw CLIError(message: "The model does not match this operation") }
        let url = model.appendingPathComponent(file)
        if method == "mlx-vsr" { options.superResolutionWeights = url }
        else { options.frameGenerationWeights = url }
      } else { throw CLIError(message: "Choose a supported neural operation") }
      if let factor = arguments.values["--frame-factor"] {
        guard let value = Int(factor), (2...16).contains(value) else { throw CLIError(message: "Frame factor must be between 2 and 16") }
        options.frameGenerationFactor = value
      }
      options.intensity = try arguments.float("--intensity", default: 1)
      guard (0...2).contains(options.intensity) else {
        throw CLIError(message: "Neural-rendering intensity must be between 0 and 2")
      }
      options.processingScale = try arguments.float("--processing-scale", default: 1)
      options.detailStrength = try arguments.float("--detail-strength", default: 1)
      options.colourStrength = try arguments.float("--colour-strength", default: 1)
      if let temporal = arguments.values["--temporal"] {
        guard ["on", "off"].contains(temporal) else { throw CLIError(message: "Temporal processing accepts on or off") }
        options.temporal = temporal == "on"
      }
      if let codec = arguments.values["--codec"] {
        guard let selected = MediaVideoCodec(rawValue: codec) else { throw CLIError(message: "Unsupported video codec") }
        options.codec = selected
      }
      if let frames = arguments.values["--frames"] {
        guard let count = Int(frames), count > 0 else { throw CLIError(message: "Frame count must be positive") }
        options.frameLimit = count
      }
      try options.validate()
      let processor = NativeMediaProcessor()
      let job = Task {
        try await processor.processVideo(input: input, output: output, options: options) { progress in
          await emit(["type": "progress", "inputFrames": progress.inputFrames,
            "outputFrames": progress.outputFrames, "estimatedInputFrames": progress.estimatedInputFrames,
            "fraction": progress.fraction, "elapsedSeconds": progress.elapsedSeconds])
        }
      }
      signal(SIGINT, SIG_IGN)
      signal(SIGTERM, SIG_IGN)
      let signals = [SIGINT, SIGTERM].map { number -> any DispatchSourceSignal in
        // The handler inherits main()'s actor isolation. Deliver signals on its
        // executor so cancellation can unwind the processor and remove staging.
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { job.cancel() }
        source.resume()
        return source
      }
      defer { for source in signals { source.cancel() } }
      do {
        let result = try await job.value
        emit(["type": "complete", "output": result.output.path, "inputFrames": result.inputFrames,
          "outputFrames": result.outputFrames, "sceneResets": result.sceneResets,
          "elapsedSeconds": result.elapsedSeconds, "motionBackend": result.motionBackend])
      } catch is CancellationError {
        emit(["type": "cancelled"])
        exit(130)
      }
    } catch {
      emit(["type": "error", "message": error.localizedDescription])
      exit(1)
    }
  }
}

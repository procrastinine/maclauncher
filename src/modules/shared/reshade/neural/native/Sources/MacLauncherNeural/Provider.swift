import CNeural
import CoreVideo
import DLSSCore
import DLSSMLX
import DLSSMedia
import Foundation
import IOSurface
import Metal
import MLX

private struct ProviderError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private struct Submission: @unchecked Sendable {
  let source: CVPixelBuffer
  let destination: CVPixelBuffer
  let sourceTexture: any MTLTexture
  let destinationTexture: any MTLTexture
  let event: any MTLSharedEvent
  let producer: UInt64
  let done: UInt64
  let frameID: UInt64
  let reset: Bool
  let completion: MLNeuralCompletion?
  let context: UnsafeMutableRawPointer?
  var timing: NeuralTimingJob? = NeuralTimingSubmission.current
}

private final class SourceWait: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Bool, Never>?
  init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
  func finish(_ ready: Bool) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: ready)
  }
}

/// Each instance owns one game's model, temporal history and scheduling lane.
private final class Provider: @unchecked Sendable {
  let device: any MTLDevice
  let metalQueue: any MTLCommandQueue
  let queue = DispatchQueue(label: "MacLauncher neural rendering", qos: .userInitiated)
  let listener: MTLSharedEventListener
  let modelURL: URL
  let intensity: Float
  let temporal: Bool
  let alphaPipeline: any MTLComputePipelineState
  let opaquePipeline: any MTLComputePipelineState
  let opaqueFlag: any MTLBuffer
  private var closed = false
  private var active = false
  private var pending: [Submission] = []
  private var lastFrame: UInt64?
  private var temporalSequence = TemporalRenderSequence()
  private var sourceWait: SourceWait?
  private var renderer: MLXNeuralRenderingDeviceTemporalBackend?
  private var writer: (width: Int, height: Int, value: MLXPixelBufferWriter)?
  private var flow: (width: Int, height: Int, value: NativeOpticalFlow)?
  private var independentFrameCache: IndependentFrameCache?

  init(modelPath: String, intensity: Float = 1, temporal: Bool = false) throws {
    guard !modelPath.isEmpty, FileManager.default.fileExists(atPath: modelPath) else {
      throw ProviderError(message: "Select a local neural-rendering model package")
    }
    guard let device = MTLCreateSystemDefaultDevice(), let metalQueue = device.makeCommandQueue() else {
      throw ProviderError(message: "Metal is unavailable")
    }
    guard intensity.isFinite, (0...2).contains(intensity) else {
      throw ProviderError(message: "Neural-rendering intensity must be between 0 and 2")
    }
    let alphaSource = """
      #include <metal_stdlib>
      using namespace metal;
      kernel void preserve_alpha(device const uchar *source [[buffer(0)]],
        device uchar *destination [[buffer(1)]], constant uint4 &size [[buffer(2)]],
        uint2 p [[thread_position_in_grid]]) {
        if (p.x < size.x && p.y < size.y)
          destination[p.y * size.w + p.x * 4 + 3] = source[p.y * size.z + p.x * 4 + 3];
      }
      """ + "\n" + IndependentFrameCache.inspectionKernel
    let library = try device.makeLibrary(source: alphaSource, options: nil)
    guard let function = library.makeFunction(name: "preserve_alpha"),
      let opaqueFunction = library.makeFunction(name: "check_source"),
      let opaqueFlag = device.makeBuffer(length: MemoryLayout<UInt32>.size, options: .storageModeShared) else {
      throw ProviderError(message: "Cannot prepare neural-rendering output")
    }
    self.alphaPipeline = try device.makeComputePipelineState(function: function)
    self.opaquePipeline = try device.makeComputePipelineState(function: opaqueFunction)
    self.opaqueFlag = opaqueFlag
    self.device = device
    self.metalQueue = metalQueue
    self.modelURL = URL(fileURLWithPath: modelPath, isDirectory: true)
    self.intensity = intensity
    self.temporal = temporal
    self.independentFrameCache = temporal ? nil : IndependentFrameCache()
    self.listener = MTLSharedEventListener(dispatchQueue: queue)
  }

  func texture(_ buffer: CVPixelBuffer) throws -> any MTLTexture {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
      !CVPixelBufferIsPlanar(buffer),
      let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else {
      throw ProviderError(message: "Neural rendering requires an IOSurface BGRA8 frame")
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
      width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer), mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = [.shaderRead, .shaderWrite]
    guard let texture = device.makeTexture(descriptor: descriptor, iosurface: surface, plane: 0) else {
      throw ProviderError(message: "Cannot bind the neural-rendering frame")
    }
    return texture
  }

  func submit(_ frame: Submission) -> Int32 {
    queue.sync {
      guard !closed else { return Int32(ML_NEURAL_CLOSED.rawValue) }
      guard !active || pending.isEmpty else { return Int32(ML_NEURAL_BUSY.rawValue) }
      guard frame.done > frame.producer,
        frame.reset || (lastFrame.map({ frame.frameID > $0 }) ?? true) else {
        return Int32(ML_NEURAL_INVALID.rawValue)
      }
      lastFrame = frame.frameID
      pending.append(frame)
      startNext()
      return Int32(ML_NEURAL_RENDERED.rawValue)
    }
  }

  func close() {
    queue.sync {
      closed = true
      sourceWait?.finish(false)
    }
  }

  private func startNext() {
    guard !active, !pending.isEmpty else { return }
    active = true
    let frame = pending.removeFirst()
    Task { [self, frame] in
      await MLXGPUJob.withToken(frame.timing?.captureToken ?? 0) {
        await Device.withDefaultDevice(Device(.gpu)) { await process(frame) }
      }
      queue.async { [self] in
        active = false
        startNext()
      }
    }
  }

  private func waitForSource(_ frame: Submission) async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      let wait = SourceWait(continuation)
      queue.async { [self] in
        guard !closed else { wait.finish(false); return }
        sourceWait = wait
        frame.event.notify(listener, atValue: frame.producer) { _, _ in wait.finish(true) }
        queue.asyncAfter(deadline: .now() + 10) { wait.finish(false) }
      }
    }
  }

  private func process(_ frame: Submission) async {
    guard await waitForSource(frame) else {
      temporalSequence.reset()
      await renderer?.reset(sequenceID: 1)
      await flow?.value.reset()
      if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) }
      "Neural-rendering source was not submitted".withCString {
        frame.completion?(frame.context, Int32(ML_NEURAL_FAILED.rawValue), $0)
      }
      return
    }
    queue.sync { sourceWait = nil }
    var status = Int32(ML_NEURAL_RENDERED.rawValue)
    var message = ""
    var outputTexture = frame.sourceTexture
    var renderedBuffer: MLXPixelBuffer?
    do {
      if intensity == 0 {
        try await publish(frame.sourceTexture, frame: frame)
        "".withCString { frame.completion?(frame.context, Int32(ML_NEURAL_PASSTHROUGH.rawValue), $0) }
        return
      }
      independentFrameCache?.prepare(device: device, width: frame.sourceTexture.width,
        height: frame.sourceTexture.height, frameID: frame.frameID, reset: frame.reset)
      let inspection = try await inspectSource(frame)
      guard inspection.opaque else {
        independentFrameCache?.invalidate()
        temporalSequence.reset()
        await renderer?.reset(sequenceID: 1)
        await flow?.value.reset()
        try await publish(frame.sourceTexture, frame: frame)
        "Neural rendering requires an opaque SDR frame".withCString {
          frame.completion?(frame.context, Int32(ML_NEURAL_PASSTHROUGH.rawValue), $0)
        }
        return
      }
      if inspection.unchanged, let cached = independentFrameCache?.output {
        try await publish(texture(cached.buffer), frame: frame)
        "Exact-frame cache".withCString { frame.completion?(frame.context, Int32(ML_NEURAL_RENDERED.rawValue), $0) }
        return
      }
      independentFrameCache?.invalidate()
      if renderer == nil {
        renderer = try MLXNeuralRenderingDeviceTemporalBackend(packageURL: modelURL,
          executionMode: .metalFused, computePrecision: .float16)
      }
      let width = frame.sourceTexture.width, height = frame.sourceTexture.height
      if writer?.width != width || writer?.height != height {
        writer = (width, height, try MLXPixelBufferWriter(width: width, height: height))
      }
      let input = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(frame.source))
      // Actual source IDs remain in the C ABI and caller diagnostics. The
      // temporal backend's consecutive cadence follows only rendered images.
      let step = temporal ? temporalSequence.advance(sourceFrameID: frame.frameID,
        width: width, height: height, reset: frame.reset) : nil
      let reset = step?.reset ?? frame.reset
      var motion: MLXVideoMotion?
      if temporal {
        if flow?.width != width || flow?.height != height {
          flow = (width, height, try NativeOpticalFlow(width: width, height: height))
        }
        if reset { await flow!.value.reset() }
        motion = try await flow!.value.prepare(input, index: Int(step!.frameIndex),
          sceneCutThreshold: 0.3)
      }
      let result = try await renderer!.renderVideoFrame(input, motion: motion,
        context: .init(streamID: 1, frameIndex: step?.frameIndex ?? frame.frameID,
          discontinuity: reset ? .explicit : nil),
        processingScale: 1, temporal: temporal,
        outputOptions: try MLXVideoOutputOptions(width: width, height: height), intensity: intensity)
      renderedBuffer = try await writer!.value.write(result)
      outputTexture = try texture(renderedBuffer!.buffer)
      independentFrameCache?.retain(renderedBuffer!)
    } catch {
      independentFrameCache?.invalidate()
      temporalSequence.reset()
      status = Int32(ML_NEURAL_PASSTHROUGH.rawValue)
      message = error.localizedDescription
      await renderer?.reset(sequenceID: 1)
      await flow?.value.reset()
    }

    do {
      try await publish(outputTexture, frame: frame)
    } catch {
      independentFrameCache?.invalidate()
      temporalSequence.reset()
      status = Int32(ML_NEURAL_FAILED.rawValue)
      message = error.localizedDescription
      // Keep fallback image traffic on the GPU as well. If the device cannot
      // publish even the original image, retain the caller's initialized output
      // and release ownership with an explicit failed completion.
      do { try await publish(frame.sourceTexture, frame: frame) }
      catch { if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) } }
    }
    withExtendedLifetime(renderedBuffer) {}
    if let completion = frame.completion {
      message.withCString { completion(frame.context, status, $0) }
    }
  }

  private func inspectSource(_ frame: Submission) async throws -> (opaque: Bool, unchanged: Bool) {
    guard let surface = CVPixelBufferGetIOSurface(frame.source)?.takeUnretainedValue(),
      let bytes = device.makeBuffer(bytesNoCopy: IOSurfaceGetBaseAddress(surface),
        length: IOSurfaceGetAllocSize(surface), options: .storageModeShared),
      let command = metalQueue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
      throw ProviderError(message: "Cannot inspect neural-rendering frame alpha")
    }
    opaqueFlag.contents().storeBytes(of: UInt32(0), as: UInt32.self)
    let snapshot = independentFrameCache?.source
    let comparison: UInt32 = snapshot == nil ? 0 : independentFrameCache?.output == nil ? 1 : 3
    var size = SIMD4<UInt32>(UInt32(frame.sourceTexture.width), UInt32(frame.sourceTexture.height),
      UInt32(CVPixelBufferGetBytesPerRow(frame.source)), comparison)
    encoder.setComputePipelineState(opaquePipeline)
    encoder.setBuffer(bytes, offset: 0, index: 0)
    encoder.setBuffer(opaqueFlag, offset: 0, index: 1)
    encoder.setBytes(&size, length: MemoryLayout.size(ofValue: size), index: 2)
    encoder.setBuffer(snapshot ?? opaqueFlag, offset: 0, index: 3)
    encoder.dispatchThreads(.init(width: frame.sourceTexture.width, height: frame.sourceTexture.height, depth: 1),
      threadsPerThreadgroup: .init(width: 16, height: 16, depth: 1))
    encoder.endEncoding()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      command.addCompletedHandler { completed in
        if let error = completed.error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
      MLXGPUJob.observe(command)
      command.commit()
    }
    let flags = opaqueFlag.contents().load(as: UInt32.self)
    return (flags & 1 == 0, comparison == 3 && flags & 2 == 0)
  }

  private func publish(_ source: any MTLTexture, frame: Submission) async throws {
    guard let command = metalQueue.makeCommandBuffer(), let blit = command.makeBlitCommandEncoder() else {
      throw ProviderError(message: "Cannot publish the neural-rendering frame")
    }
    blit.copy(from: source, sourceSlice: 0, sourceLevel: 0, sourceOrigin: .init(x: 0, y: 0, z: 0),
      sourceSize: .init(width: source.width, height: source.height, depth: 1),
      to: frame.destinationTexture, destinationSlice: 0, destinationLevel: 0,
      destinationOrigin: .init(x: 0, y: 0, z: 0))
    blit.endEncoding()
    guard let sourceSurface = CVPixelBufferGetIOSurface(frame.source)?.takeUnretainedValue(),
      let targetSurface = CVPixelBufferGetIOSurface(frame.destination)?.takeUnretainedValue(),
      let sourceBytes = device.makeBuffer(bytesNoCopy: IOSurfaceGetBaseAddress(sourceSurface),
        length: IOSurfaceGetAllocSize(sourceSurface), options: .storageModeShared),
      let targetBytes = device.makeBuffer(bytesNoCopy: IOSurfaceGetBaseAddress(targetSurface),
        length: IOSurfaceGetAllocSize(targetSurface), options: .storageModeShared),
      let encoder = command.makeComputeCommandEncoder() else {
      throw ProviderError(message: "Cannot retain source alpha for neural rendering")
    }
    var size = SIMD4<UInt32>(UInt32(source.width), UInt32(source.height),
      UInt32(CVPixelBufferGetBytesPerRow(frame.source)), UInt32(CVPixelBufferGetBytesPerRow(frame.destination)))
    encoder.setComputePipelineState(alphaPipeline)
    encoder.setBuffer(sourceBytes, offset: 0, index: 0)
    encoder.setBuffer(targetBytes, offset: 0, index: 1)
    encoder.setBytes(&size, length: MemoryLayout.size(ofValue: size), index: 2)
    encoder.dispatchThreads(.init(width: source.width, height: source.height, depth: 1),
      threadsPerThreadgroup: .init(width: 16, height: 16, depth: 1))
    encoder.endEncoding()
    if frame.timing == nil { command.encodeSignalEvent(frame.event, value: frame.done) }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      command.addCompletedHandler { completed in
        if let error = completed.error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
      MLXGPUJob.observe(command)
      command.commit()
    }
  }

}

private func copyError(_ message: String, to output: UnsafeMutablePointer<CChar>?, capacity: Int) {
  guard let output, capacity > 0 else { return }
  let bytes = Array(message.utf8.prefix(capacity - 1))
  for (index, byte) in bytes.enumerated() { output[index] = CChar(bitPattern: byte) }
  output[bytes.count] = 0
}

@_cdecl("ml_neural_create")
public func createProvider(_ path: UnsafePointer<CChar>?, _ errorBuffer: UnsafeMutablePointer<CChar>?,
  _ capacity: Int) -> UnsafeMutableRawPointer? {
  createProviderWithOptions(path, 1, 0, errorBuffer, capacity)
}

@_cdecl("ml_neural_create_with_options")
public func createProviderWithOptions(_ path: UnsafePointer<CChar>?, _ intensity: Float, _ temporal: Int32,
  _ errorBuffer: UnsafeMutablePointer<CChar>?, _ capacity: Int) -> UnsafeMutableRawPointer? {
  do {
    guard let path else { throw ProviderError(message: "A local model package is required") }
    return Unmanaged.passRetained(try Provider(modelPath: String(cString: path),
      intensity: intensity, temporal: temporal != 0)).toOpaque()
  } catch {
    copyError(error.localizedDescription, to: errorBuffer, capacity: capacity)
    return nil
  }
}

@_cdecl("ml_neural_submit")
public func submitFrame(_ handle: UnsafeMutableRawPointer?, _ source: UnsafeRawPointer?,
  _ destination: UnsafeRawPointer?, _ event: UnsafeRawPointer?, _ producer: UInt64, _ done: UInt64,
  _ frameID: UInt64, _ reset: Int32, _ completion: MLNeuralCompletion?,
  _ context: UnsafeMutableRawPointer?) -> Int32 {
  guard let handle, let source, let destination, let event else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let owner = Unmanaged<Provider>.fromOpaque(handle).takeUnretainedValue()
  let input = Unmanaged<CVPixelBuffer>.fromOpaque(source).takeUnretainedValue()
  let output = Unmanaged<CVPixelBuffer>.fromOpaque(destination).takeUnretainedValue()
  guard let shared = Unmanaged<AnyObject>.fromOpaque(event).takeUnretainedValue() as? any MTLSharedEvent,
    (shared.device == nil || shared.device?.registryID == owner.device.registryID),
    CVPixelBufferGetWidth(input) == CVPixelBufferGetWidth(output),
    CVPixelBufferGetHeight(input) == CVPixelBufferGetHeight(output), input !== output else {
    return Int32(ML_NEURAL_INVALID.rawValue)
  }
  do {
    return owner.submit(Submission(source: input, destination: output,
      sourceTexture: try owner.texture(input), destinationTexture: try owner.texture(output),
      event: shared, producer: producer, done: done, frameID: frameID, reset: reset != 0,
      completion: completion, context: context))
  } catch { return Int32(ML_NEURAL_INVALID.rawValue) }
}

@_cdecl("ml_neural_destroy")
public func destroyProvider(_ handle: UnsafeMutableRawPointer?) {
  guard let handle else { return }
  let owner = Unmanaged<Provider>.fromOpaque(handle).takeRetainedValue()
  owner.close()
}

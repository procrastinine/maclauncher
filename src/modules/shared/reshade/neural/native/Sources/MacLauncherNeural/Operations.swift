import CNeural
import CoreVideo
import DLSSMLX
import DLSSMedia
import Foundation
import IOSurface
import Metal
import MLX

private struct OperationError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

private final class OperationWait: @unchecked Sendable {
  let lock = NSLock()
  var continuation: CheckedContinuation<Bool, Never>?
  init(_ value: CheckedContinuation<Bool, Never>) { continuation = value }
  func finish(_ ready: Bool) {
    let value = lock.withLock { let value = continuation; continuation = nil; return value }
    value?.resume(returning: ready)
  }
}

private struct OperationFrame: @unchecked Sendable {
  let source: CVPixelBuffer
  let next: CVPixelBuffer?
  let destination: CVPixelBuffer
  let event: any MTLSharedEvent
  let producer: UInt64
  let done: UInt64
  let frameID: UInt64
  let nextID: UInt64
  let phase: Float
  let reset: Bool
  let completion: MLNeuralCompletion?
  let context: UnsafeMutableRawPointer?
  var timing: NeuralTimingJob? = NeuralTimingSubmission.current
  var destinations: [CVPixelBuffer] = []
  var phases: [Float] = []
  var guides: CVPixelBuffer? = nil
}

private struct DepthPreparation: @unchecked Sendable {
  let width: Int
  let height: Int
  let completion: MLNeuralCompletion?
  let context: UnsafeMutableRawPointer?
}

/// ABI 2 owns operations, not display timing. All graph work remains off the
/// caller's borrowed command buffer; the shared event publishes completion.
private final class OperationProvider: @unchecked Sendable {
  let operation: UInt32
  let intrinsicScale: Int
  let modelURL: URL
  let temporal: Bool
  let intensity: Float
  let denoiseStrength: Float
  let device: any MTLDevice
  let commands: any MTLCommandQueue
  let queue = DispatchQueue(label: "MacLauncher neural operation", qos: .userInitiated)
  let listener: MTLSharedEventListener
  let publishPipeline: any MTLComputePipelineState
  let legacy: UnsafeMutableRawPointer?
  private var closed = false
  private var active = false
  private var pending: [OperationFrame] = []
  private var pendingDepth: DepthPreparation?
  private var wait: OperationWait?
  private var lastFrame: UInt64?
  private var srvgg: SRVGGRestoration?
  private var nafnet: NAFRestoration?
  private var cugan: CUGANRestoration?
  private var rife: RIFEInterpolation?
  private var vsr: MLXNativeSuperResolver?
  private var sr: MLXNativeDLSSSuperResolver?
  private var generator: MLXNativeFrameGenerator?
  private var depth: DepthAnythingV2?
  private var depthIO: DepthPixelIO?
  private var writer: (Int, Int, MLXPixelBufferWriter)?
  private var flow: (Int, Int, NativeOpticalFlow)?
  private var sequence = TemporalRenderSequence()

  init(path: String, options: MLNeuralOptionsV2) throws {
    guard [UInt32(ML_NEURAL_NR.rawValue),UInt32(ML_NEURAL_VSR.rawValue),UInt32(ML_NEURAL_SR_IMAGE.rawValue),UInt32(ML_NEURAL_INTERPOLATION.rawValue),UInt32(ML_NEURAL_SR_SCENE.rawValue),UInt32(ML_NEURAL_SRVGG.rawValue),UInt32(ML_NEURAL_CUGAN.rawValue),UInt32(ML_NEURAL_NAFNET.rawValue),UInt32(ML_NEURAL_RIFE.rawValue),UInt32(ML_NEURAL_DEPTH_ANYTHING_V2_SMALL.rawValue)].contains(options.operation),
      options.intensity.isFinite, (0...2).contains(options.intensity),
      FileManager.default.fileExists(atPath: path),
      let device = MTLCreateSystemDefaultDevice(), let commands = device.makeCommandQueue() else {
      throw OperationError(message: "Choose an available neural operation and local model")
    }
    operation = options.operation
    if options.operation == UInt32(ML_NEURAL_CUGAN.rawValue) {
      intrinsicScale = try CUGANRestoration.modelScale(modelURL:URL(fileURLWithPath:path,isDirectory:true))
    }else{
      intrinsicScale = [UInt32(ML_NEURAL_INTERPOLATION.rawValue),UInt32(ML_NEURAL_NAFNET.rawValue),UInt32(ML_NEURAL_RIFE.rawValue)].contains(options.operation) ? 1 : options.operation == UInt32(ML_NEURAL_SRVGG.rawValue) ? 4:2
    }
    modelURL = URL(fileURLWithPath: path, isDirectory: true)
    temporal = options.temporal != 0
    intensity = options.intensity
    denoiseStrength = options.reserved.1 == 1 ? Float(bitPattern: options.reserved.0) : 1
    self.device = device
    self.commands = commands
    listener = MTLSharedEventListener(dispatchQueue: queue)
    let source = """
      #include <metal_stdlib>
      using namespace metal;
      kernel void publish_image(texture2d<float,access::sample> result [[texture(0)]],
        texture2d<float,access::sample> original [[texture(1)]],
        texture2d<float,access::write> target [[texture(2)]],
        texture2d<float,access::sample> next [[texture(3)]],constant float &phase [[buffer(0)]],uint2 p [[thread_position_in_grid]]) {
        if(p.x>=target.get_width()||p.y>=target.get_height())return;
        constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);
        float2 uv=(float2(p)+.5f)/float2(target.get_width(),target.get_height());
        float4 c=result.sample(s,uv);c.a=mix(original.sample(s,uv).a,next.sample(s,uv).a,phase);target.write(c,p);
      }
      """
    let library = try device.makeLibrary(source: source, options: nil)
    guard let function = library.makeFunction(name: "publish_image") else {
      throw OperationError(message: "Cannot prepare neural output")
    }
    publishPipeline = try device.makeComputePipelineState(function: function)
    if operation == UInt32(ML_NEURAL_NR.rawValue) {
      var error = [CChar](repeating: 0, count: 512)
      legacy = path.withCString { createProviderWithOptions($0, options.intensity, Int32(options.temporal), &error, error.count) }
      guard legacy != nil else { throw OperationError(message: String(cString: error)) }
    } else { legacy = nil }
  }

  private func weightsURL(expected: String) throws -> URL {
    let data = try Data(contentsOf: modelURL.appendingPathComponent("manifest.json"))
    guard let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      manifest["architecture"] as? String == expected,
      let weights = manifest["weights"] as? [String: Any], let file = weights["file"] as? String,
      !file.isEmpty, URL(fileURLWithPath: file).lastPathComponent == file else {
      throw OperationError(message: "The selected model does not match this neural operation")
    }
    return modelURL.appendingPathComponent(file)
  }

  func texture(_ buffer: CVPixelBuffer) throws -> any MTLTexture {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
      !CVPixelBufferIsPlanar(buffer), let surface = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else {
      throw OperationError(message: "Neural operations require IOSurface BGRA8 images")
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm,
      width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer), mipmapped: false)
    descriptor.storageMode = .shared
    descriptor.usage = [.shaderRead, .shaderWrite]
    guard let texture = device.makeTexture(descriptor: descriptor, iosurface: surface, plane: 0) else {
      throw OperationError(message: "Cannot bind neural operation images")
    }
    return texture
  }

  func submit(_ frame: OperationFrame) -> Int32 {
    queue.sync {
      guard !closed else { return Int32(ML_NEURAL_CLOSED.rawValue) }
      guard !active || pending.isEmpty else { return Int32(ML_NEURAL_BUSY.rawValue) }
      guard frame.done > frame.producer,
        frame.reset || lastFrame.map({ frame.frameID > $0 || [UInt32(ML_NEURAL_INTERPOLATION.rawValue),UInt32(ML_NEURAL_RIFE.rawValue)].contains(operation) && frame.frameID == $0 }) ?? true else {
        return Int32(ML_NEURAL_INVALID.rawValue)
      }
      lastFrame = frame.frameID
      pending.append(frame)
      startNext()
      return Int32(ML_NEURAL_RENDERED.rawValue)
    }
  }

  private func startNext() {
    guard !active else { return }
    if let job = pendingDepth {
      pendingDepth = nil
      active = true
      Task { [self, job] in
        var status = Int32(ML_NEURAL_RENDERED.rawValue), message = ""
        Device.withDefaultDevice(Device(.gpu)) {
          do {
            if depth == nil { depth = try DepthAnythingV2(modelURL: modelURL) }
            if depthIO == nil { depthIO = try DepthPixelIO(device: device) }
            try depthIO!.warm(depth!, width: job.width, height: job.height)
          } catch { status = Int32(ML_NEURAL_FAILED.rawValue); message = error.localizedDescription }
        }
        message.withCString { job.completion?(job.context, status, $0) }
        queue.async { [self] in active = false; startNext() }
      }
      return
    }
    guard !pending.isEmpty else { return }
    active = true
    let frame = pending.removeFirst()
    Task { [self, frame] in
      await MLXGPUJob.withToken(frame.timing?.captureToken ?? 0) {
        await Device.withDefaultDevice(Device(.gpu)) { await process(frame) }
      }
      queue.async { [self] in active = false; startNext() }
    }
  }

  func prepareDepth(width: UInt32, height: UInt32, completion: MLNeuralCompletion?, context: UnsafeMutableRawPointer?) -> Int32 {
    guard operation == UInt32(ML_NEURAL_DEPTH_ANYTHING_V2_SMALL.rawValue), width > 0, height > 0,
      width <= 4096, height <= 4096, width % 14 == 0, height % 14 == 0 else { return Int32(ML_NEURAL_INVALID.rawValue) }
    return queue.sync {
      guard !closed else { return Int32(ML_NEURAL_CLOSED.rawValue) }
      guard pendingDepth == nil else { return Int32(ML_NEURAL_BUSY.rawValue) }
      pendingDepth = .init(width: Int(width), height: Int(height), completion: completion, context: context)
      startNext()
      return Int32(ML_NEURAL_RENDERED.rawValue)
    }
  }

  func close() {
    if let legacy { destroyProvider(legacy) }
    queue.sync { closed = true; wait?.finish(false) }
  }

  private func ready(_ frame: OperationFrame) async -> Bool {
    await withCheckedContinuation { continuation in
      let pending = OperationWait(continuation)
      queue.async { [self] in
        guard !closed else { pending.finish(false); return }
        wait = pending
        frame.event.notify(listener, atValue: frame.producer) { _, _ in pending.finish(true) }
        queue.asyncAfter(deadline: .now() + 10) { pending.finish(false) }
      }
    }
  }

  private func process(_ frame: OperationFrame) async {
    guard await ready(frame) else {
      "Neural source was not submitted".withCString { frame.completion?(frame.context, Int32(ML_NEURAL_FAILED.rawValue), $0) }
      if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) }
      return
    }
    queue.sync { wait = nil }
    if operation == UInt32(ML_NEURAL_DEPTH_ANYTHING_V2_SMALL.rawValue) {
      var status = Int32(ML_NEURAL_RENDERED.rawValue), message = ""
      do {
        if depth == nil { depth = try DepthAnythingV2(modelURL: modelURL) }
        if depthIO == nil { depthIO = try DepthPixelIO(device: device) }
        try await depthIO!.render(depth!, source: frame.source, destination: frame.destination)
      } catch { status = Int32(ML_NEURAL_FAILED.rawValue); message = error.localizedDescription }
      message.withCString { frame.completion?(frame.context, status, $0) }
      if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) }
      return
    }
    if !frame.destinations.isEmpty { await processBatch(frame); return }
    var status = Int32(ML_NEURAL_RENDERED.rawValue), message = ""
    var result: MLXPixelBuffer?
    do {
      if intensity == 0 && operation != UInt32(ML_NEURAL_SRVGG.rawValue) { status = Int32(ML_NEURAL_PASSTHROUGH.rawValue) }
      else {
        let input = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(frame.source))
        let width = CVPixelBufferGetWidth(frame.source), height = CVPixelBufferGetHeight(frame.source)
        let output: MLXVideoFrame
        if operation == UInt32(ML_NEURAL_CUGAN.rawValue) {
          if cugan == nil { cugan = try CUGANRestoration(modelURL: modelURL) }
          output = input.transformingRGB { cugan!($0) }
        } else if operation == UInt32(ML_NEURAL_NAFNET.rawValue) {
          if nafnet == nil { nafnet = try NAFRestoration(modelURL: modelURL) }
          output = input.transformingRGB { nafnet!($0) }
        } else if operation == UInt32(ML_NEURAL_SRVGG.rawValue) {
          if srvgg == nil { srvgg = try SRVGGRestoration(modelURL: modelURL, denoise: denoiseStrength) }
          output = input.transformingRGB { srvgg!($0) }
        } else if operation == UInt32(ML_NEURAL_VSR.rawValue) {
          if vsr == nil { vsr = try MLXNativeSuperResolver(weightsURL: weightsURL(expected: "mlxdlss.rtx-vsr-1.8.2.mode16.v1")) }
          output = try await vsr!.upscale(input)
        } else if operation == UInt32(ML_NEURAL_SR_SCENE.rawValue) {
          guard let guides = frame.guides else { throw OperationError(message: "Scene SR requires actual scene motion and depth") }
          if sr == nil { sr = try MLXNativeDLSSSuperResolver(packageURL: modelURL) }
          let step = sequence.advance(sourceFrameID: frame.frameID, width: width, height: height, reset: frame.reset)
          output = try await sr!.upscaleScene(input,guides: MLXPixelBuffer(guides),reset: step.reset)
        } else if operation == UInt32(ML_NEURAL_SR_IMAGE.rawValue) {
          if sr == nil { sr = try MLXNativeDLSSSuperResolver(packageURL: modelURL) }
          let step = sequence.advance(sourceFrameID: frame.frameID, width: width, height: height, reset: frame.reset)
          var motion: MLXVideoMotion?
          if temporal {
            if flow?.0 != width || flow?.1 != height { flow = (width, height, try NativeOpticalFlow(width: width, height: height)) }
            if step.reset { await flow!.2.reset() }
            motion = try await flow!.2.prepare(input, index: Int(step.frameIndex), sceneCutThreshold: 0.3)
          }
          output = try await sr!.upscale(input, motion: motion, temporal: temporal && !step.reset)
        } else {
          guard let next = frame.next else { throw OperationError(message: "Interpolation requires two real images") }
          let second = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(next))
          if operation == UInt32(ML_NEURAL_RIFE.rawValue) {
            if rife == nil { rife = try RIFEInterpolation(modelURL: modelURL) }
            output = input.transformingRGB(with: second) { rife!($0,$1,phase:frame.phase) }
          } else {
            if generator == nil { generator = try MLXNativeFrameGenerator(weightsURL: weightsURL(expected: "mlxdlss.video-frame-generation.v1")) }
            output = try await generator!.interpolate(input, second, phases: [frame.phase])[0]
          }
        }
        let outWidth = CVPixelBufferGetWidth(frame.destination), outHeight = CVPixelBufferGetHeight(frame.destination)
        if writer?.0 != outWidth || writer?.1 != outHeight { writer = (outWidth, outHeight, try MLXPixelBufferWriter(width: outWidth, height: outHeight)) }
        result = try await writer!.2.write(output)
      }
    } catch {
      status = Int32(ML_NEURAL_PASSTHROUGH.rawValue)
      message = error.localizedDescription
      sequence.reset()
      sr = nil
      await flow?.2.reset()
    }
    do { try await publish(result?.buffer ?? frame.source, frame: frame, signal: false) }
    catch {
      status = Int32(ML_NEURAL_FAILED.rawValue)
      message = error.localizedDescription
      // Caller-owned initialized output remains valid on publication failure.
    }
    withExtendedLifetime(result) {}
    message.withCString { frame.completion?(frame.context, status, $0) }
    // Publish terminal metadata before releasing the caller's result gate.
    // The awaited Metal publish above already completed all output GPU work.
    if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) }
  }

  private func processBatch(_ frame: OperationFrame) async {
    var status = Int32(ML_NEURAL_RENDERED.rawValue), message = ""
    do {
      guard let next = frame.next else { throw OperationError(message: "Interpolation requires two real images") }
      let a = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(frame.source)), b = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(next))
      let outputs:[MLXVideoFrame]
      if operation == UInt32(ML_NEURAL_RIFE.rawValue) {
        if rife == nil { rife = try RIFEInterpolation(modelURL: modelURL) }
        outputs = frame.phases.map {phase in a.transformingRGB(with:b){rife!($0,$1,phase:phase)}}
      } else {
        if generator == nil { generator = try MLXNativeFrameGenerator(weightsURL:weightsURL(expected:"mlxdlss.video-frame-generation.v1")) }
        outputs = try await generator!.interpolate(a,b,phases:frame.phases)
      }
      let width = CVPixelBufferGetWidth(frame.destination), height = CVPixelBufferGetHeight(frame.destination)
      if writer?.0 != width || writer?.1 != height { writer = (width,height,try MLXPixelBufferWriter(width: width,height: height)) }
      for index in outputs.indices {
        let image = try await writer!.2.write(outputs[index])
        try await publish(image.buffer, frame: frame, destination: frame.destinations[index],
          phase: frame.phases[index], signal: false)
      }
    } catch {
      status = Int32(ML_NEURAL_PASSTHROUGH.rawValue); message = error.localizedDescription
      do {
        for index in frame.destinations.indices {
          try await publish(frame.source, frame: frame, destination: frame.destinations[index],
            phase: frame.phases[index], signal: false)
        }
      } catch {
        status = Int32(ML_NEURAL_FAILED.rawValue); message = error.localizedDescription
      }
    }
    message.withCString { frame.completion?(frame.context,status,$0) }
    if frame.timing == nil { frame.event.signaledValue = max(frame.event.signaledValue, frame.done) }
  }

  private func publish(_ image: CVPixelBuffer, frame: OperationFrame,
    destination: CVPixelBuffer? = nil, phase: Float? = nil, signal: Bool = true) async throws {
    let source = try texture(image), original = try texture(frame.source), output = try texture(destination ?? frame.destination)
    guard let command = commands.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
      throw OperationError(message: "Cannot publish neural output")
    }
    encoder.setComputePipelineState(publishPipeline)
    encoder.setTexture(source, index: 0); encoder.setTexture(original, index: 1); encoder.setTexture(output, index: 2)
    encoder.setTexture(try texture(frame.next ?? frame.source), index: 3)
    var alphaPhase: Float = frame.next == nil ? 0 : phase ?? frame.phase
    encoder.setBytes(&alphaPhase, length: MemoryLayout<Float>.size, index: 0)
    encoder.dispatchThreads(.init(width: output.width, height: output.height, depth: 1), threadsPerThreadgroup: .init(width: 8, height: 8, depth: 1))
    encoder.endEncoding()
    if signal && frame.timing == nil { command.encodeSignalEvent(frame.event, value: frame.done) }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      command.addCompletedHandler { done in
        if let error = done.error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
      MLXGPUJob.observe(command)
      command.commit()
    }
  }
}

@_cdecl("ml_neural_abi_version") public func neuralABIVersion() -> UInt32 { 3 }
@_cdecl("ml_neural_depth_api") public func neuralDepthAPI() -> UInt32 { 1 }
@_cdecl("ml_neural_timing_api") public func neuralTimingAPI() -> UInt32 { 1 }
@_cdecl("ml_neural_timing_supported_v1")
public func neuralTimingSupported(_ handle: UnsafeMutableRawPointer?) -> UInt32 {
  guard let handle else { return 0 }
  let owner=Unmanaged<OperationProvider>.fromOpaque(handle).takeUnretainedValue()
  if owner.operation == UInt32(ML_NEURAL_SR_SCENE.rawValue) { return 0 }
  if owner.temporal && [UInt32(ML_NEURAL_NR.rawValue),UInt32(ML_NEURAL_SR_IMAGE.rawValue)].contains(owner.operation) { return 0 }
  if owner.operation == UInt32(ML_NEURAL_NR.rawValue) && ProcessInfo.processInfo.environment["MLXDLSS_NR_DEVICE_FEATURES"] == "0" { return 0 }
  return 1
}
private func timedSubmission(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralFrameV2>?,
  token: UInt64, timing: MLNeuralTimingCompletion?, completion: MLNeuralCompletion?, context: UnsafeMutableRawPointer?,
  submit: (MLNeuralCompletion?,UnsafeMutableRawPointer?) -> Int32) -> Int32 {
  guard neuralTimingSupported(handle) == 1, let descriptor, descriptor.pointee.size >= MemoryLayout<MLNeuralFrameV2>.size,
    descriptor.pointee.version == 2, let job=NeuralTimingJob(token:token,frame:descriptor.pointee,timing:timing,completion:completion,context:context) else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let retained=Unmanaged.passRetained(job).toOpaque()
  let accepted=NeuralTimingSubmission.$current.withValue(job) { submit(neuralTimedTerminal,retained) }
  if accepted != Int32(ML_NEURAL_RENDERED.rawValue) { Unmanaged<NeuralTimingJob>.fromOpaque(retained).release();job.abandon() }
  return accepted
}
@_cdecl("ml_neural_submit_timed_v1")
public func submitTimedOperation(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralFrameV2>?,
  _ token: UInt64, _ timing: MLNeuralTimingCompletion?, _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  timedSubmission(handle,descriptor,token:token,timing:timing,completion:completion,context:context) { callback,opaque in
    submitOperation(handle,descriptor,callback,opaque)
  }
}
@_cdecl("ml_neural_submit_batch_timed_v1")
public func submitTimedOperationBatch(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralFrameV2>?,
  _ destinations: UnsafePointer<UnsafeRawPointer?>?, _ phases: UnsafePointer<Float>?, _ count: UInt32,
  _ token: UInt64, _ timing: MLNeuralTimingCompletion?, _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  timedSubmission(handle,descriptor,token:token,timing:timing,completion:completion,context:context) { callback,opaque in
    submitOperationBatch(handle,descriptor,destinations,phases,count,callback,opaque)
  }
}
@_cdecl("ml_neural_prepare_depth_v1")
public func prepareDepthOperation(_ handle: UnsafeMutableRawPointer?, _ width: UInt32, _ height: UInt32,
  _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  guard let handle else { return Int32(ML_NEURAL_INVALID.rawValue) }
  return Unmanaged<OperationProvider>.fromOpaque(handle).takeUnretainedValue().prepareDepth(
    width: width, height: height, completion: completion, context: context)
}

@_cdecl("ml_neural_create_v2")
public func createOperation(_ path: UnsafePointer<CChar>?, _ options: UnsafePointer<MLNeuralOptionsV2>?,
  _ error: UnsafeMutablePointer<CChar>?, _ capacity: Int) -> UnsafeMutableRawPointer? {
  do {
    guard let path, let options, options.pointee.size >= MemoryLayout<MLNeuralOptionsV2>.size,
      options.pointee.version == 2 else { throw OperationError(message: "Unsupported neural operation ABI") }
    return Unmanaged.passRetained(try OperationProvider(path: String(cString: path), options: options.pointee)).toOpaque()
  } catch let problem {
    if let error, capacity > 0 {
      let bytes = Array(problem.localizedDescription.utf8.prefix(capacity - 1))
      for (index, byte) in bytes.enumerated() { error[index] = CChar(bitPattern: byte) }; error[bytes.count] = 0
    }
    return nil
  }
}

@_cdecl("ml_neural_submit_v2")
public func submitOperation(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralFrameV2>?,
  _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  guard let handle, let descriptor, descriptor.pointee.size >= MemoryLayout<MLNeuralFrameV2>.size,
    descriptor.pointee.version == 2 else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let owner = Unmanaged<OperationProvider>.fromOpaque(handle).takeUnretainedValue(), value = descriptor.pointee
  guard let source = value.source, let destination = value.destination, let event = value.shared_event else { return Int32(ML_NEURAL_INVALID.rawValue) }
  if let legacy = owner.legacy {
    return submitFrame(legacy, source, destination, event, value.producer_value, value.done_value,
      value.frame_id, Int32(value.reset_history), completion, context)
  }
  let input = Unmanaged<CVPixelBuffer>.fromOpaque(source).takeUnretainedValue()
  let output = Unmanaged<CVPixelBuffer>.fromOpaque(destination).takeUnretainedValue()
  let next = value.next_source.map { Unmanaged<CVPixelBuffer>.fromOpaque($0).takeUnretainedValue() }
  guard let shared = Unmanaged<AnyObject>.fromOpaque(event).takeUnretainedValue() as? any MTLSharedEvent,
    shared.device == nil || shared.device?.registryID == owner.device.registryID, input !== output else { return Int32(ML_NEURAL_INVALID.rawValue) }
  if owner.operation == UInt32(ML_NEURAL_DEPTH_ANYTHING_V2_SMALL.rawValue) {
    guard next == nil, CVPixelBufferGetPixelFormatType(input) == kCVPixelFormatType_32BGRA,
      CVPixelBufferGetPixelFormatType(output) == kCVPixelFormatType_OneComponent32Float,
      !CVPixelBufferIsPlanar(input), !CVPixelBufferIsPlanar(output), CVPixelBufferGetIOSurface(input) != nil,
      CVPixelBufferGetIOSurface(output) != nil, CVPixelBufferGetWidth(output) > 0, CVPixelBufferGetHeight(output) > 0,
      CVPixelBufferGetWidth(output) <= 4096, CVPixelBufferGetHeight(output) <= 4096,
      CVPixelBufferGetWidth(output) % 14 == 0, CVPixelBufferGetHeight(output) % 14 == 0 else { return Int32(ML_NEURAL_INVALID.rawValue) }
    return owner.submit(.init(source: input, next: nil, destination: output, event: shared,
      producer: value.producer_value, done: value.done_value, frameID: value.frame_id, nextID: 0,
      phase: 0, reset: value.reset_history != 0, completion: completion, context: context))
  }
  let scale = owner.intrinsicScale
  guard CVPixelBufferGetWidth(output) == CVPixelBufferGetWidth(input) * scale,
    CVPixelBufferGetHeight(output) == CVPixelBufferGetHeight(input) * scale else { return Int32(ML_NEURAL_INVALID.rawValue) }
  if [UInt32(ML_NEURAL_INTERPOLATION.rawValue),UInt32(ML_NEURAL_RIFE.rawValue)].contains(owner.operation) {
    guard let next, next !== output, value.phase.isFinite, value.phase > 0, value.phase < 1,
      value.next_frame_id > value.frame_id, CVPixelBufferGetWidth(next) == CVPixelBufferGetWidth(input),
      CVPixelBufferGetHeight(next) == CVPixelBufferGetHeight(input) else { return Int32(ML_NEURAL_INVALID.rawValue) }
  }
  do {
    _ = try owner.texture(input); _ = try owner.texture(output)
    if let next { _ = try owner.texture(next) }
    return owner.submit(.init(source: input, next: next, destination: output, event: shared,
      producer: value.producer_value, done: value.done_value, frameID: value.frame_id,
      nextID: value.next_frame_id, phase: value.phase, reset: value.reset_history != 0,
      completion: completion, context: context))
  } catch { return Int32(ML_NEURAL_INVALID.rawValue) }
}

@_cdecl("ml_neural_destroy_v2")
public func destroyOperation(_ handle: UnsafeMutableRawPointer?) {
  guard let handle else { return }
  Unmanaged<OperationProvider>.fromOpaque(handle).takeRetainedValue().close()
}

@_cdecl("ml_neural_submit_scene_v3")
public func submitSceneOperation(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralSceneFrameV3>?,
  _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  guard let handle, let descriptor, descriptor.pointee.size >= MemoryLayout<MLNeuralSceneFrameV3>.size,
    descriptor.pointee.version == 3 else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let owner = Unmanaged<OperationProvider>.fromOpaque(handle).takeUnretainedValue(), scene = descriptor.pointee, value = descriptor.pointee.frame
  guard owner.operation == UInt32(ML_NEURAL_SR_SCENE.rawValue), value.size >= MemoryLayout<MLNeuralFrameV2>.size,
    value.version == 2, let source = value.source, let destination = value.destination, let event = value.shared_event,
    let guides = scene.guides, let shared = Unmanaged<AnyObject>.fromOpaque(event).takeUnretainedValue() as? any MTLSharedEvent,
    shared.device == nil || shared.device?.registryID == owner.device.registryID else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let input = Unmanaged<CVPixelBuffer>.fromOpaque(source).takeUnretainedValue(), output = Unmanaged<CVPixelBuffer>.fromOpaque(destination).takeUnretainedValue(), guide = Unmanaged<CVPixelBuffer>.fromOpaque(guides).takeUnretainedValue()
  guard input !== output, CVPixelBufferGetWidth(output) == CVPixelBufferGetWidth(input)*2,
    CVPixelBufferGetHeight(output) == CVPixelBufferGetHeight(input)*2,
    CVPixelBufferGetWidth(guide) == CVPixelBufferGetWidth(input), CVPixelBufferGetHeight(guide) == CVPixelBufferGetHeight(input),
    CVPixelBufferGetPixelFormatType(guide) == kCVPixelFormatType_128RGBAFloat,
    !CVPixelBufferIsPlanar(guide), CVPixelBufferGetIOSurface(guide) != nil else { return Int32(ML_NEURAL_INVALID.rawValue) }
  do {
    _ = try owner.texture(input); _ = try owner.texture(output)
    return owner.submit(.init(source: input,next: nil,destination: output,event: shared,
      producer: value.producer_value,done: value.done_value,frameID: value.frame_id,nextID: 0,
      phase: 0,reset: value.reset_history != 0,completion: completion,context: context,guides: guide))
  } catch { return Int32(ML_NEURAL_INVALID.rawValue) }
}

@_cdecl("ml_neural_submit_batch_v2")
public func submitOperationBatch(_ handle: UnsafeMutableRawPointer?, _ descriptor: UnsafePointer<MLNeuralFrameV2>?,
  _ destinations: UnsafePointer<UnsafeRawPointer?>?, _ phases: UnsafePointer<Float>?, _ count: UInt32,
  _ completion: MLNeuralCompletion?, _ context: UnsafeMutableRawPointer?) -> Int32 {
  guard let handle, let descriptor, let destinations, let phases, count > 0, count <= 15,
    descriptor.pointee.size >= MemoryLayout<MLNeuralFrameV2>.size, descriptor.pointee.version == 2 else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let owner = Unmanaged<OperationProvider>.fromOpaque(handle).takeUnretainedValue(), value = descriptor.pointee
  guard [UInt32(ML_NEURAL_INTERPOLATION.rawValue),UInt32(ML_NEURAL_RIFE.rawValue)].contains(owner.operation), let source = value.source,
    let next = value.next_source, let event = value.shared_event, value.next_frame_id > value.frame_id,
    let shared = Unmanaged<AnyObject>.fromOpaque(event).takeUnretainedValue() as? any MTLSharedEvent,
    shared.device == nil || shared.device?.registryID == owner.device.registryID else { return Int32(ML_NEURAL_INVALID.rawValue) }
  let input = Unmanaged<CVPixelBuffer>.fromOpaque(source).takeUnretainedValue(), second = Unmanaged<CVPixelBuffer>.fromOpaque(next).takeUnretainedValue()
  var buffers: [CVPixelBuffer] = [], timestamps: [Float] = [], previous: Float = 0
  do {
    _ = try owner.texture(input); _ = try owner.texture(second)
    guard CVPixelBufferGetWidth(second) == CVPixelBufferGetWidth(input), CVPixelBufferGetHeight(second) == CVPixelBufferGetHeight(input) else { return Int32(ML_NEURAL_INVALID.rawValue) }
    for index in 0..<Int(count) {
      guard let pointer = destinations[index], phases[index].isFinite, phases[index] > previous, phases[index] < 1 else { return Int32(ML_NEURAL_INVALID.rawValue) }
      let output = Unmanaged<CVPixelBuffer>.fromOpaque(pointer).takeUnretainedValue()
      guard output !== input, output !== second, !buffers.contains(where: { $0 === output }),
        CVPixelBufferGetWidth(output) == CVPixelBufferGetWidth(input), CVPixelBufferGetHeight(output) == CVPixelBufferGetHeight(input) else { return Int32(ML_NEURAL_INVALID.rawValue) }
      _ = try owner.texture(output); buffers.append(output); timestamps.append(phases[index]); previous = phases[index]
    }
    return owner.submit(.init(source: input,next: second,destination: buffers[0],event: shared,
      producer: value.producer_value,done: value.done_value,frameID: value.frame_id,nextID: value.next_frame_id,
      phase: timestamps[0],reset: value.reset_history != 0,completion: completion,context: context,
      destinations: buffers,phases: timestamps))
  } catch { return Int32(ML_NEURAL_INVALID.rawValue) }
}

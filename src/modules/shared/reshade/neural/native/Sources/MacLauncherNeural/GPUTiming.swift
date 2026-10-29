// Copyright (c) MacLauncher contributors. MIT license.
import Cmlx
import CNeural
import Foundation
import Metal
import MLX

enum NeuralTimingSubmission {
  @TaskLocal static var current: NeuralTimingJob?
}
private final class ObserverTokens: @unchecked Sendable {
  static let shared = ObserverTokens()
  private let lock = NSLock()
  private var next: UInt64 = 1
  func allocate() -> UInt64 {
    lock.lock(); defer { lock.unlock() }
    guard next != 0 else { return 0 }
    let value=next; next &+= 1; return value
  }
}

final class NeuralTimingJob: @unchecked Sendable {
  let token: UInt64
  private let observerToken: UInt64
  let capturing: Bool
  var captureToken: UInt64 { capturing ? observerToken : 0 }
  let event: any MTLSharedEvent
  let done: UInt64
  let timing: MLNeuralTimingCompletion?
  let completion: MLNeuralCompletion?
  let context: UnsafeMutableRawPointer?
  private var status = Int32(ML_NEURAL_FAILED.rawValue)
  private var message = ""

  init?(token: UInt64, frame: MLNeuralFrameV2, timing: MLNeuralTimingCompletion?,
        completion: MLNeuralCompletion?, context: UnsafeMutableRawPointer?) {
    guard token != 0, let pointer = frame.shared_event,
      let event = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue() as? any MTLSharedEvent else { return nil }
    self.token=token;self.event=event;done=frame.done_value;self.timing=timing
    observerToken=ObserverTokens.shared.allocate()
    capturing=observerToken != 0 && maclauncher_mlx_gpu_job_begin(observerToken) == 1
    self.completion=completion;self.context=context
  }
  func abandon() {
    if capturing { maclauncher_mlx_gpu_job_finish(observerToken, { _, _ in }, nil) }
  }
  func finish(status: Int32, message: String) {
    self.status=status;self.message=message
    if !capturing {
      var receipt=MLNeuralGPUTimingV1();receipt.size=UInt32(MemoryLayout<MLNeuralGPUTimingV1>.size)
      receipt.version=1;receipt.job_token=token;receipt.status=UInt32(ML_NEURAL_GPU_TIMING_UNSUPPORTED.rawValue)
      timing?(context,&receipt);message.withCString { completion?(context,status,$0) }
      event.signaledValue=max(event.signaledValue,done);return
    }
    let retained=Unmanaged.passRetained(self).toOpaque()
    maclauncher_mlx_gpu_job_finish(observerToken, { pointer, source in
      guard let pointer, let source else { return }
      let job=Unmanaged<NeuralTimingJob>.fromOpaque(pointer).takeRetainedValue()
      var receipt=MLNeuralGPUTimingV1()
      receipt.size=UInt32(MemoryLayout<MLNeuralGPUTimingV1>.size);receipt.version=1
      receipt.job_token=job.token;receipt.gpu_nanoseconds=source.pointee.gpu_nanoseconds
      receipt.command_buffers=source.pointee.command_buffers;receipt.status=source.pointee.status
      if job.status != Int32(ML_NEURAL_RENDERED.rawValue) {
        receipt.status=UInt32(job.status == Int32(ML_NEURAL_PASSTHROUGH.rawValue) ? ML_NEURAL_GPU_TIMING_UNSUPPORTED.rawValue : ML_NEURAL_GPU_TIMING_FAILED.rawValue)
        receipt.gpu_nanoseconds=0
      }
      job.timing?(job.context,&receipt)
      job.message.withCString { job.completion?(job.context,job.status,$0) }
      // Every observed command buffer has actually completed. This CPU metadata
      // notification never stands in for a missing GPU completion or timeout.
      job.event.signaledValue=max(job.event.signaledValue,job.done)
    },retained)
  }
}

let neuralTimedTerminal: MLNeuralCompletion = { pointer,status,message in
  guard let pointer else { return }
  let job=Unmanaged<NeuralTimingJob>.fromOpaque(pointer).takeRetainedValue()
  job.finish(status:status,message:message.map(String.init(cString:)) ?? "")
}

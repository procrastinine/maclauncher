// Copyright (c) MacLauncher contributors. MIT license.
import Cmlx
import Metal

/// The token is passed explicitly at each synchronous evaluation entrypoint.
/// Actual GPU intervals belong to the backend's retained command buffers.
public enum MLXGPUJob {
  @TaskLocal private static var token: UInt64 = 0
  public static var currentToken: UInt64 { token }
  public static func withToken<T>(_ value: UInt64, operation: () async throws -> T) async rethrows -> T {
    try await $token.withValue(value, operation: operation)
  }
  public static func observe(_ command: any MTLCommandBuffer) {
    if token != 0 {
      maclauncher_mlx_gpu_job_observe(token, Unmanaged.passUnretained(command as AnyObject).toOpaque())
    }
  }
}

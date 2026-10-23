import CoreVideo
import DLSSMLX
import Metal
import XCTest

@testable import MacLauncherNeural

final class IndependentFrameCacheTests: XCTestCase {
  private func frame(width: Int = 13, height: Int = 7) throws -> MLXPixelBuffer {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferMetalCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
      &buffer)
    XCTAssertEqual(status, kCVReturnSuccess)
    return MLXPixelBuffer(try XCTUnwrap(buffer))
  }

  func testRetainsOutputAcrossForwardGapsUntilResetRewindOrExtentChange() throws {
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    var cache = IndependentFrameCache()
    cache.prepare(device: device, width: 13, height: 7, frameID: 1, reset: false)
    XCTAssertEqual(cache.source?.length, 13 * 7 * 4)
    let originalSnapshot = cache.source
    let output = try frame()
    cache.retain(output)
    XCTAssertTrue(cache.output?.buffer === output.buffer)
    cache.prepare(device: device, width: 13, height: 7, frameID: 5, reset: false)
    XCTAssertTrue(cache.source === originalSnapshot)
    XCTAssertNotNil(cache.output)
    cache.prepare(device: device, width: 13, height: 7, frameID: 4, reset: false)
    XCTAssertNil(cache.output)
    cache.retain(output)
    cache.prepare(device: device, width: 13, height: 7, frameID: 4, reset: false)
    XCTAssertNil(cache.output)
    cache.retain(output)
    cache.prepare(device: device, width: 13, height: 7, frameID: 5, reset: true)
    XCTAssertNil(cache.output)
    cache.retain(output)
    cache.prepare(device: device, width: 14, height: 7, frameID: 6, reset: false)
    XCTAssertNil(cache.output)
    XCTAssertEqual(cache.source?.length, 14 * 7 * 4)
    XCTAssertFalse(cache.source === originalSnapshot)
    cache.retain(output)
    XCTAssertNil(cache.output)
  }

  func testActualInspectionKernelFindsGapHitAndChangedPixelMissWithoutWeights() throws {
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    let queue = try XCTUnwrap(device.makeCommandQueue())
    let library = try device.makeLibrary(source: IndependentFrameCache.inspectionKernel, options: nil)
    let pipeline = try device.makeComputePipelineState(function: XCTUnwrap(library.makeFunction(name: "check_source")))
    let width = 13, height = 7, stride = 64
    let input = try XCTUnwrap(device.makeBuffer(length: stride * height, options: .storageModeShared))
    let flags = try XCTUnwrap(device.makeBuffer(length: MemoryLayout<UInt32>.size, options: .storageModeShared))
    let bytes = input.contents().assumingMemoryBound(to: UInt8.self)
    for index in 0..<(stride * height) { bytes[index] = 0xEE }
    for y in 0..<height { for x in 0..<width {
      let offset = y * stride + x * 4
      bytes[offset] = UInt8(x);bytes[offset + 1] = UInt8(y)
      bytes[offset + 2] = UInt8(x + y);bytes[offset + 3] = 255
    } }
    var cache = IndependentFrameCache()
    func inspect() throws -> UInt32 {
      let command = try XCTUnwrap(queue.makeCommandBuffer())
      let encoder = try XCTUnwrap(command.makeComputeCommandEncoder())
      let previous = try XCTUnwrap(cache.source)
      flags.contents().storeBytes(of: UInt32(0), as: UInt32.self)
      var size = SIMD4<UInt32>(UInt32(width), UInt32(height), UInt32(stride), cache.output == nil ? 1 : 3)
      encoder.setComputePipelineState(pipeline)
      encoder.setBuffer(input, offset: 0, index: 0);encoder.setBuffer(flags, offset: 0, index: 1)
      encoder.setBytes(&size, length: MemoryLayout.size(ofValue: size), index: 2)
      encoder.setBuffer(previous, offset: 0, index: 3)
      encoder.dispatchThreads(.init(width: width, height: height, depth: 1), threadsPerThreadgroup: .init(width: 16, height: 16, depth: 1))
      encoder.endEncoding();command.commit();command.waitUntilCompleted()
      XCTAssertEqual(command.status, .completed)
      return flags.contents().load(as: UInt32.self)
    }
    cache.prepare(device: device, width: width, height: height, frameID: 1, reset: false)
    XCTAssertEqual(try inspect(), 0, "first inspection snapshots the real padded source")
    let output = try frame();cache.retain(output)
    cache.prepare(device: device, width: width, height: height, frameID: 5, reset: false)
    XCTAssertTrue(cache.output?.buffer === output.buffer)
    XCTAssertEqual(try inspect(), 0, "identical source at ID5 reuses the retained ID1 result")
    // Padding never participates in exact visible-pixel identity.
    bytes[width * 4] ^= 0xFF
    XCTAssertEqual(try inspect(), 0)
    bytes[3 * stride + 6 * 4 + 2] ^= 1
    cache.prepare(device: device, width: width, height: height, frameID: 9, reset: false)
    XCTAssertEqual(try inspect(), 2, "one changed visible RGB byte rejects the cached result")
    bytes[4 * stride + 2 * 4 + 3] = 17
    XCTAssertEqual(try inspect(), 3, "alpha eligibility and exact byte changes remain independently detected")
  }

  func testOversizedOrOverflowingExtentsAllocateNothing() throws {
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    var cache = IndependentFrameCache()
    for (width, height) in [(8192, 8192), (Int.max, 2), (0, 7)] {
      cache.prepare(device: device, width: width, height: height, frameID: 1, reset: false)
      XCTAssertNil(cache.source)
      XCTAssertNil(cache.output)
    }
  }
}

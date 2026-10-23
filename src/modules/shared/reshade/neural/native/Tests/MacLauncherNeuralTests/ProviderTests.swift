import CNeural
import CoreVideo
import Darwin
import DLSSMLX
import Foundation
import Metal
import XCTest

private final class Completion: @unchecked Sendable {
  let expectation: XCTestExpectation
  private let lock = NSLock()
  private var value: Int32?
  private var text = ""
  init(_ expectation: XCTestExpectation) { self.expectation = expectation }
  var status: Int32? { lock.withLock { value } }
  var message: String { lock.withLock { text } }
  func finish(_ status: Int32, message: String) {
    lock.withLock { value = status; text = message }
    expectation.fulfill()
  }
}

private let finished: MLNeuralCompletion = { context, status, message in
  guard let context else { return }
  Unmanaged<Completion>.fromOpaque(context).takeRetainedValue().finish(status,
    message: message.map { String(cString: $0) } ?? "")
}

private struct ProviderTestError: Error { let message: String }
private final class ProviderAPI: @unchecked Sendable {
  typealias Create = @convention(c) (UnsafePointer<CChar>?, UnsafeMutablePointer<CChar>?, Int) -> UnsafeMutableRawPointer?
  typealias CreateWithOptions = @convention(c) (UnsafePointer<CChar>?, Float, Int32, UnsafeMutablePointer<CChar>?, Int) -> UnsafeMutableRawPointer?
  typealias Submit = @convention(c) (UnsafeMutableRawPointer?, UnsafeRawPointer?, UnsafeRawPointer?, UnsafeRawPointer?, UInt64, UInt64, UInt64, Int32, MLNeuralCompletion?, UnsafeMutableRawPointer?) -> Int32
  typealias Destroy = @convention(c) (UnsafeMutableRawPointer?) -> Void
  let create: Create
  let createWithOptions: CreateWithOptions
  let submit: Submit
  let destroy: Destroy
  // The library remains loaded through asynchronous provider destruction.
  let handle: UnsafeMutableRawPointer
  init() throws {
    let file = ProcessInfo.processInfo.environment["MACLAUNCHER_NEURAL_TEST_LIBRARY"] ??
      Bundle(for: ProviderTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("libMacLauncherNeural.dylib").path
    guard let handle = dlopen(file, RTLD_NOW | RTLD_LOCAL) else {
      throw ProviderTestError(message: "Cannot load provider: \(String(cString: dlerror()))")
    }
    self.handle = handle
    func symbol<T>(_ name: String, _: T.Type) throws -> T {
      guard let address = dlsym(handle, name) else { throw ProviderTestError(message: "Missing provider ABI: \(name)") }
      return unsafeBitCast(address, to: T.self)
    }
    create = try symbol("ml_neural_create", Create.self)
    createWithOptions = try symbol("ml_neural_create_with_options", CreateWithOptions.self)
    submit = try symbol("ml_neural_submit", Submit.self)
    destroy = try symbol("ml_neural_destroy", Destroy.self)
    print("Neural test library: \(file)")
  }
  static let shared = Result { try ProviderAPI() }
}

final class ProviderTests: XCTestCase, @unchecked Sendable {
  private func pixelBuffer(width: Int = 13, height: Int = 7) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferMetalCompatibilityKey: true, kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
      &buffer)
    XCTAssertEqual(status, kCVReturnSuccess)
    return try XCTUnwrap(buffer)
  }

  private func fill(_ buffer: CVPixelBuffer, seed: UInt8) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let address = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<CVPixelBufferGetHeight(buffer) {
      for x in 0..<(CVPixelBufferGetWidth(buffer) * 4) {
        address[y * CVPixelBufferGetBytesPerRow(buffer) + x] = seed &+ UInt8(truncatingIfNeeded: x + y * 7)
      }
    }
  }

  private func rows(_ buffer: CVPixelBuffer) -> [UInt8] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let address = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    return (0..<CVPixelBufferGetHeight(buffer)).flatMap { y in
      Array(UnsafeBufferPointer(start: address.advanced(by: y * CVPixelBufferGetBytesPerRow(buffer)),
        count: CVPixelBufferGetWidth(buffer) * 4))
    }
  }

  private func temporaryModel() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".dlssmodel")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    return directory
  }

  func testZeroIntensityWaitsForProducerAndPreservesEveryChannel() async throws {
    let api = try ProviderAPI.shared.get()
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    let event = try XCTUnwrap(device.makeSharedEvent())
    let model = try temporaryModel()
    let owner = try XCTUnwrap(model.path.withCString { api.createWithOptions($0, 0, 0, nil, 0) })
    defer { api.destroy(owner) }
    let source = try pixelBuffer(), destination = try pixelBuffer()
    fill(source, seed: 17)
    fill(destination, seed: 0)
    let completion = Completion(expectation(description: "GPU output complete"))
    let context = Unmanaged.passRetained(completion).toOpaque()
    let accepted = api.submit(owner, Unmanaged.passUnretained(source).toOpaque(),
      Unmanaged.passUnretained(destination).toOpaque(), Unmanaged.passUnretained(event as AnyObject).toOpaque(),
      1, 2, 1, 0, finished, context)
    guard accepted == ML_NEURAL_RENDERED.rawValue else {
      Unmanaged<Completion>.fromOpaque(context).release()
      XCTFail("Provider rejected valid IOSurface frames: \(accepted)")
      return
    }
    let command = try XCTUnwrap(device.makeCommandQueue()?.makeCommandBuffer())
    command.encodeSignalEvent(event, value: 1)
    command.encodeWaitForEvent(event, value: 2)
    command.commit()
    await fulfillment(of: [completion.expectation], timeout: 5)
    XCTAssertEqual(completion.status, Int32(ML_NEURAL_PASSTHROUGH.rawValue))
    XCTAssertGreaterThanOrEqual(event.signaledValue, 2)
    XCTAssertEqual(rows(source), rows(destination))
  }

  func testDestroyReleasesUnsubmittedFrameWithoutReadingSource() async throws {
    let api = try ProviderAPI.shared.get()
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    let event = try XCTUnwrap(device.makeSharedEvent())
    let model = try temporaryModel()
    let owner = try XCTUnwrap(model.path.withCString { api.create($0, nil, 0) })
    let source = try pixelBuffer(), destination = try pixelBuffer()
    fill(destination, seed: 99)
    let original = rows(destination)
    let completion = Completion(expectation(description: "Abandoned source released"))
    let context = Unmanaged.passRetained(completion).toOpaque()
    let accepted = api.submit(owner, Unmanaged.passUnretained(source).toOpaque(),
      Unmanaged.passUnretained(destination).toOpaque(), Unmanaged.passUnretained(event as AnyObject).toOpaque(),
      1, 2, 1, 0, finished, context)
    guard accepted == ML_NEURAL_RENDERED.rawValue else {
      Unmanaged<Completion>.fromOpaque(context).release()
      api.destroy(owner)
      XCTFail("Provider rejected valid IOSurface frames: \(accepted)")
      return
    }
    api.destroy(owner)
    await fulfillment(of: [completion.expectation], timeout: 5)
    XCTAssertEqual(completion.status, Int32(ML_NEURAL_FAILED.rawValue))
    XCTAssertEqual(rows(destination), original)
    XCTAssertGreaterThanOrEqual(event.signaledValue, 2)
  }

  func testSupportedIntensityRange() throws {
    let api = try ProviderAPI.shared.get()
    let model = try temporaryModel()
    for intensity in [-0.01, 2.01, Float.nan, Float.infinity] {
      XCTAssertNil(model.path.withCString { api.createWithOptions($0, intensity, 0, nil, 0) })
    }
    for intensity in [Float(0), 1, 2] {
      let owner = try XCTUnwrap(model.path.withCString { api.createWithOptions($0, intensity, 0, nil, 0) })
      api.destroy(owner)
    }
  }

  func testPinnedMetalLibraryImportsAndExportsNativeRGB() async throws {
    let source = try pixelBuffer()
    fill(source, seed: 31)
    let frame = try MLXVideoFrame(pixelBuffer: MLXPixelBuffer(source))
    let writer = try MLXPixelBufferWriter(width: CVPixelBufferGetWidth(source), height: CVPixelBufferGetHeight(source))
    let output = try await writer.write(frame)
    let expected = rows(source), actual = rows(output.buffer)
    for index in expected.indices where index % 4 != 3 { XCTAssertEqual(actual[index], expected[index]) }
  }

  func testNonopaqueFramePassesThroughBeforeModelLoading() async throws {
    let api = try ProviderAPI.shared.get()
    let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
    let event = try XCTUnwrap(device.makeSharedEvent())
    let model = try temporaryModel()
    let owner = try XCTUnwrap(model.path.withCString { api.create($0, nil, 0) })
    defer { api.destroy(owner) }
    let source = try pixelBuffer(), destination = try pixelBuffer()
    fill(source, seed: 23)
    let completion = Completion(expectation(description: "Nonopaque source copied"))
    let context = Unmanaged.passRetained(completion).toOpaque()
    let accepted = api.submit(owner, Unmanaged.passUnretained(source).toOpaque(),
      Unmanaged.passUnretained(destination).toOpaque(), Unmanaged.passUnretained(event as AnyObject).toOpaque(),
      1, 2, 1, 0, finished, context)
    guard accepted == ML_NEURAL_RENDERED.rawValue else {
      Unmanaged<Completion>.fromOpaque(context).release()
      XCTFail("Provider rejected valid IOSurface frames: \(accepted)")
      return
    }
    event.signaledValue = 1
    await fulfillment(of: [completion.expectation], timeout: 5)
    XCTAssertEqual(completion.status, Int32(ML_NEURAL_PASSTHROUGH.rawValue))
    XCTAssertTrue(completion.message.contains("opaque SDR"))
    XCTAssertEqual(rows(source), rows(destination))
  }
}

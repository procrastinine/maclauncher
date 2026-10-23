import XCTest
@testable import MacLauncherNeural

final class TemporalRenderSequenceTests: XCTestCase {
  func testForwardProducerGapsKeepConsecutiveRenderHistory() {
    var sequence = TemporalRenderSequence()
    XCTAssertEqual(sequence.advance(sourceFrameID: 10, width: 960, height: 540, reset: false),
      .init(frameIndex: 0, reset: true))
    XCTAssertEqual(sequence.advance(sourceFrameID: 14, width: 960, height: 540, reset: false),
      .init(frameIndex: 1, reset: false))
    XCTAssertEqual(sequence.advance(sourceFrameID: 100, width: 960, height: 540, reset: false),
      .init(frameIndex: 2, reset: false))
  }

  func testExplicitRewindExtentAndFailureStartNewHistory() {
    var sequence = TemporalRenderSequence()
    _ = sequence.advance(sourceFrameID: 10, width: 960, height: 540, reset: false)
    XCTAssertTrue(sequence.advance(sourceFrameID: 5, width: 960, height: 540, reset: false).reset)
    XCTAssertEqual(sequence.advance(sourceFrameID: 5, width: 960, height: 540, reset: false),
      .init(frameIndex: 0, reset: true))
    XCTAssertEqual(sequence.advance(sourceFrameID: 6, width: 960, height: 540, reset: true),
      .init(frameIndex: 0, reset: true))
    XCTAssertEqual(sequence.advance(sourceFrameID: 7, width: 854, height: 480, reset: false),
      .init(frameIndex: 0, reset: true))
    sequence.reset()
    XCTAssertEqual(sequence.advance(sourceFrameID: 100, width: 854, height: 480, reset: false),
      .init(frameIndex: 0, reset: true))
  }
}

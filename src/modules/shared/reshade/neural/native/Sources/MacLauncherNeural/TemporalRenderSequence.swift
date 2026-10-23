/// Upstream history and optical flow operate on the ordered images actually
/// rendered, independently of gaps in a faster producer's source frame IDs.
struct TemporalRenderSequence {
  struct Step: Equatable {
    let frameIndex: UInt64
    let reset: Bool
  }

  private var sourceFrameID: UInt64?
  private var width = 0
  private var height = 0
  private var nextIndex: UInt64 = 0

  mutating func advance(sourceFrameID current: UInt64, width: Int, height: Int,
                        reset explicit: Bool) -> Step {
    let reset = explicit || sourceFrameID == nil || sourceFrameID.map { current <= $0 } == true ||
      self.width != width || self.height != height || nextIndex >= UInt64(Int.max)
    if reset { nextIndex = 0 }
    let result = Step(frameIndex: nextIndex, reset: reset)
    nextIndex += 1
    sourceFrameID = current
    self.width = width
    self.height = height
    return result
  }

  mutating func reset() {
    sourceFrameID = nil
    width = 0
    height = 0
    nextIndex = 0
  }
}

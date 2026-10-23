import CoreVideo
import DLSSMLX
import IOSurface
import Metal

/// One exact independent-frame result. Submitted IOSurfaces may be reused by
/// their producer, so the source is retained as a separate packed GPU snapshot.
struct IndependentFrameCache {
  static let maximumBytes = 64 * 1024 * 1024
  // Shared with the provider so the no-weights regression exercises its actual
  // opacity/comparison kernel, including padded input rows and packed history.
  static let inspectionKernel = """
    #include <metal_stdlib>
    using namespace metal;
    kernel void check_source(device const uchar *source [[buffer(0)]],
      device atomic_uint *flag [[buffer(1)]], constant uint4 &size [[buffer(2)]],
      device uint *previous [[buffer(3)]], uint2 p [[thread_position_in_grid]],
      ushort lane [[thread_index_in_simdgroup]]) {
      uint flags = 0u;
      if (p.x < size.x && p.y < size.y) {
        uchar4 pixel = *reinterpret_cast<device const uchar4 *>(source + p.y * size.z + p.x * 4);
        uint packed = as_type<uint>(pixel);
        flags = pixel.w != 255 ? 1u : 0u;
        if (size.w & 1u) {
          uint index = p.y * size.x + p.x;
          if ((size.w & 2u) && previous[index] != packed) flags |= 2u;
          previous[index] = packed;
        }
      }
      uint combined = simd_or(flags);
      if (lane == 0 && combined) atomic_fetch_or_explicit(flag, combined, memory_order_relaxed);
    }
    """
  private(set) var source: (any MTLBuffer)?
  private(set) var output: MLXPixelBuffer?
  private var width = 0
  private var height = 0
  private var frameID: UInt64?

  mutating func prepare(device: any MTLDevice, width: Int, height: Int,
    frameID: UInt64, reset: Bool) {
    if self.width != width || self.height != height {
      source = nil
      output = nil
      self.width = width
      self.height = height
    }
    // Independent images have no consecutive temporal cadence. A slow model
    // may accept source IDs 1, 5, 9 while the producer continues drawing.
    if reset || self.frameID.map({ frameID <= $0 }) ?? false { output = nil }
    self.frameID = frameID
    // The output requires at least the same number of bytes as the snapshot.
    // Avoid allocating a snapshot when the pair cannot fit the total budget.
    let (pixels, pixelOverflow) = width.multipliedReportingOverflow(by: height)
    let (bytes, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
    guard width > 0, height > 0, !pixelOverflow, !byteOverflow,
      bytes <= Self.maximumBytes / 2 else {
      source = nil
      output = nil
      return
    }
    if source == nil { source = device.makeBuffer(length: bytes, options: .storageModePrivate) }
  }

  mutating func invalidate() { output = nil }

  mutating func retain(_ frame: MLXPixelBuffer) {
    guard let source, frame.width == width, frame.height == height,
      let surface = CVPixelBufferGetIOSurface(frame.buffer)?.takeUnretainedValue(),
      source.length + IOSurfaceGetAllocSize(surface) <= Self.maximumBytes else {
      output = nil
      return
    }
    output = frame
  }
}

#ifndef MACLAUNCHER_NEURAL_H
#define MACLAUNCHER_NEURAL_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void *MLNeuralProvider;
enum MLNeuralStatus {
  ML_NEURAL_RENDERED = 0,
  ML_NEURAL_PASSTHROUGH = 1,
  ML_NEURAL_FAILED = 2,
  ML_NEURAL_INVALID = -1,
  ML_NEURAL_BUSY = -2,
  ML_NEURAL_CLOSED = -3
};
typedef void (*MLNeuralCompletion)(void *context, int status, const char *message);

/* Creation retains a local model path; weights load on the provider worker.
 * No acquisition or network access occurs. The error buffer may be NULL.
 * Intensity accepts finite values from 0 to 2; the default is 1. */
MLNeuralProvider ml_neural_create(const char *model_path, char *error, size_t error_capacity);
MLNeuralProvider ml_neural_create_with_options(const char *model_path, float intensity,
  int temporal, char *error, size_t error_capacity);

/* source/destination are CVPixelBufferRef and shared_event is id<MTLSharedEvent>,
 * each passed as an unretained opaque pointer. Accepted submissions retain all
 * three until completion. Both buffers must be non-planar IOSurface BGRA8 with
 * equal extents. Neural rendering requires opaque SDR RGB; nonopaque frames are
 * copied unchanged after a GPU alpha check. The caller must finish source writes
 * and signal producer_value.
 * The caller also initializes destination from source before signaling producer.
 * The provider asynchronously waits, renders sequentially, and copies final RGB
 * to destination on its own command queue before signaling done_value.
 * Original alpha bytes are retained. done_value must exceed producer_value and
 * event values increase between submissions on the same event.
 * No caller command buffer is committed or waited by this API.
 * One active and one queued frame are accepted. Rejection takes no ownership and
 * signals no event. Completion runs on a provider worker after the GPU finishes;
 * message is valid only for that callback. A rendered completion with message
 * "Exact-frame cache" reused an unchanged independent frame without inference.
 * Any render error publishes the source
 * as passthrough before completion. A FAILED callback indicates a GPU/storage
 * failure; the caller must disable this provider after that completion.
 * Source frame IDs must increase unless reset_history starts a new sequence.
 * Forward source-ID gaps represent skipped producer frames; temporal history
 * follows the accepted rendered images with a separate consecutive index.
 * reset_history, a source rewind, extent changes and failures reset history.
 * An unproduced frame times out after 10 seconds. Timeout or destroy before
 * production signals done and calls back FAILED without reading buffers;
 * the caller's preinitialized destination handles a late original submission. */
int ml_neural_submit(MLNeuralProvider provider, const void *source, const void *destination,
  const void *shared_event, uint64_t producer_value, uint64_t done_value,
  uint64_t frame_id, int reset_history, MLNeuralCompletion completion, void *context);

/* Stops accepting frames. Already accepted frames retain the provider and finish
 * asynchronously; source production for them must still be submitted. */
void ml_neural_destroy(MLNeuralProvider provider);

/* ABI 2 extends operation and geometry without changing ABI 1's equal-size NR
 * contract. A provider has one immutable operation/model and its own history.
 * Interpolation consumes two produced real images and an explicit phase.
 * VSR, DLSS SR and CUGAN produce 2x; SRVGG produces 4x; NAFNet preserves
 * extents. Interpolation outputs retain the pair extent. For SRVGG only,
 * reserved[1]=1 declares reserved[0] as float32 denoise-strength bits (0 weak,
 * 1 strong), used only with the exact paired general/WDN checkpoint. */
enum MLNeuralOperation {
  ML_NEURAL_NR = 0, ML_NEURAL_VSR = 1, ML_NEURAL_SR_IMAGE = 2,
  ML_NEURAL_INTERPOLATION = 3, ML_NEURAL_SR_SCENE = 4,
  ML_NEURAL_SRVGG = 5, ML_NEURAL_CUGAN = 6, ML_NEURAL_NAFNET = 7, ML_NEURAL_RIFE = 8,
  ML_NEURAL_DEPTH_ANYTHING_V2_SMALL = 9
};
typedef struct MLNeuralOptionsV2 {
  uint32_t size, version, operation, temporal;
  float intensity;
  uint32_t reserved[3];
} MLNeuralOptionsV2;
typedef struct MLNeuralFrameV2 {
  uint32_t size, version;
  const void *source, *next_source, *destination, *shared_event;
  uint64_t producer_value, done_value, frame_id, next_frame_id;
  float phase;
  uint32_t reset_history;
} MLNeuralFrameV2;
uint32_t ml_neural_abi_version(void);
MLNeuralProvider ml_neural_create_v2(const char *model_path,
  const MLNeuralOptionsV2 *, char *error, size_t error_capacity);
/* Accepted submissions retain buffers/events until completion. Source and
 * next_source (when required) are both ready at producer_value. Output is
 * preinitialized by the caller at its own extent. Completion/done and bounded
 * admission retain ABI 1 semantics; no borrowed commands are submitted. */
int ml_neural_submit_v2(MLNeuralProvider, const MLNeuralFrameV2 *,
  MLNeuralCompletion, void *context);
/* One interpolation graph evaluation for all phases. Arrays are copied during
 * submission; each distinct output is retained until the shared completion. */
int ml_neural_submit_batch_v2(MLNeuralProvider, const MLNeuralFrameV2 *,
  const void *const *destinations, const float *phases, uint32_t count,
  MLNeuralCompletion, void *context);
/* ABI 3 adds actual renderer guides without changing either earlier frame
 * structure. guides is an input-size RGBA32F IOSurface: RG are actual motion
 * in current-to-previous input pixels and B is near-to-far scene depth. Source
 * color and guides already share a zero-jitter, normalized-exposure grid.
 * The caller restores its exposure/storage contract after the GPU completion. */
typedef struct MLNeuralSceneFrameV3 {
  uint32_t size, version;
  MLNeuralFrameV2 frame;
  const void *guides;
} MLNeuralSceneFrameV3;
int ml_neural_submit_scene_v3(MLNeuralProvider, const MLNeuralSceneFrameV3 *,
  MLNeuralCompletion, void *context);
void ml_neural_destroy_v2(MLNeuralProvider);

/* Optional scalar operation extension. A version-3 library without this
 * capability does not accept scalar destinations. Source is nonplanar
 * IOSurface BGRA8 in top-left display-referred sRGB. Destination is an
 * IOSurface OneComponent32Float with positive extents divisible by14.
 * Its grid selects the exact model inference resolution; output values are
 * raw, nonnegative relative inverse depth, with no metric/camera meaning.
 * The caller initializes the destination and uses completion status to keep
 * its current image on failure. No RGB passthrough is written to scalar data.
 * Preparation loads parameters and compiles/evaluates the selected shape on
 * the GPU worker without accepting a source image or advancing history. */
uint32_t ml_neural_depth_api(void);
int ml_neural_prepare_depth_v1(MLNeuralProvider, uint32_t width, uint32_t height,
  MLNeuralCompletion, void *context);

/* Optional actual GPU timing for a v2 provider handle. Each request has an
 * explicit monotonic nonzero job_token, independent of image/frame identity.
 * Timings cover the completed MLX graph buffers across every used stream and
 * the operation's GPU conversion/publication buffers. Source readiness, CPU
 * work and IPC waits are excluded. A complete receipt requires actual MLX
 * graph execution; an unmeasured path is UNSUPPORTED, never a zero-cost model.
 * The timing callback runs before the ordinary terminal callback/done signal.
 * Query/submission do not wait for GPU work. Existing APIs remain untimed. */
enum MLNeuralGPUTimingStatus {
  ML_NEURAL_GPU_TIMING_COMPLETE = 0,
  ML_NEURAL_GPU_TIMING_UNSUPPORTED = 1,
  ML_NEURAL_GPU_TIMING_FAILED = 2
};
typedef struct MLNeuralGPUTimingV1 {
  uint32_t size, version;
  uint64_t job_token, gpu_nanoseconds;
  uint32_t command_buffers, status;
} MLNeuralGPUTimingV1;
typedef void (*MLNeuralTimingCompletion)(void *, const MLNeuralGPUTimingV1 *);
uint32_t ml_neural_timing_api(void);
uint32_t ml_neural_timing_supported_v1(MLNeuralProvider);
int ml_neural_submit_timed_v1(MLNeuralProvider, const MLNeuralFrameV2 *,
  uint64_t job_token, MLNeuralTimingCompletion, MLNeuralCompletion, void *context);
int ml_neural_submit_batch_timed_v1(MLNeuralProvider, const MLNeuralFrameV2 *,
  const void *const *destinations, const float *phases, uint32_t count,
  uint64_t job_token, MLNeuralTimingCompletion, MLNeuralCompletion, void *context);

#ifdef __cplusplus
}
#endif
#endif

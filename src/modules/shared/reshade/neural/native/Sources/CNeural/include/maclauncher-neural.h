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

#ifdef __cplusplus
}
#endif
#endif

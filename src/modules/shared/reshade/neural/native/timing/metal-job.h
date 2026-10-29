// Copyright (c) MacLauncher contributors. MIT license.
#ifndef MACLAUNCHER_MLX_METAL_JOB_H
#define MACLAUNCHER_MLX_METAL_JOB_H
#include <stdint.h>
#include "mlx/c/array.h"
#include "mlx/c/vector.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct MacLauncherMLXGPUReceipt {
  uint32_t size, version;
  uint64_t job_token, gpu_nanoseconds;
  uint32_t command_buffers, status;
} MacLauncherMLXGPUReceipt;
typedef void (*MacLauncherMLXGPUCompletion)(void *, const MacLauncherMLXGPUReceipt *);
int maclauncher_mlx_gpu_job_begin(uint64_t token);
void maclauncher_mlx_gpu_job_finish(uint64_t token, MacLauncherMLXGPUCompletion, void *);
void maclauncher_mlx_gpu_job_observe(uint64_t token, void *command_buffer);
int maclauncher_mlx_eval_gpu_job(mlx_vector_array, uint64_t token);
int maclauncher_mlx_async_eval_gpu_job(mlx_vector_array, uint64_t token);
int maclauncher_mlx_array_eval_gpu_job(mlx_array, uint64_t token);
/* Used only inside the exact synchronous C evaluation/encoding boundary. */
uint64_t maclauncher_mlx_gpu_encoding_enter(uint64_t token);
void maclauncher_mlx_gpu_encoding_leave(uint64_t previous);
#ifdef __cplusplus
}
#endif
#endif

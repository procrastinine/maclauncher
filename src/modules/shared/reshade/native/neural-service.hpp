#pragma once
#include "neural-provider.h"
MLNeuralProvider ml_neural_service_create(const char *,float,int,char *,size_t);
MLNeuralProvider ml_neural_service_create_v2(const char *,const MLNeuralOptionsV2 *,char *,size_t);
int ml_neural_service_submit(MLNeuralProvider,const void *,const void *,const void *,uint64_t,uint64_t,uint64_t,int,MLNeuralCompletion,void *);
int ml_neural_service_submit_v2(MLNeuralProvider,const MLNeuralFrameV2 *,MLNeuralCompletion,void *);
uint32_t ml_neural_service_timing_supported_v1(MLNeuralProvider);
int ml_neural_service_submit_timed_v1(MLNeuralProvider,const MLNeuralFrameV2 *,uint64_t,MLNeuralTimingCompletion,MLNeuralCompletion,void *);
int ml_neural_service_submit_batch_timed_v1(MLNeuralProvider,const MLNeuralFrameV2 *,const void *const *,const float *,uint32_t,uint64_t,MLNeuralTimingCompletion,MLNeuralCompletion,void *);
int ml_neural_service_submit_batch_v2(MLNeuralProvider,const MLNeuralFrameV2 *,const void *const *,const float *,uint32_t,MLNeuralCompletion,void *);
int ml_neural_service_submit_scene_v3(MLNeuralProvider,const MLNeuralSceneFrameV3 *,MLNeuralCompletion,void *);
int ml_neural_service_prepare_depth_v1(MLNeuralProvider,uint32_t,uint32_t,MLNeuralCompletion,void *);
void ml_neural_service_destroy(MLNeuralProvider);

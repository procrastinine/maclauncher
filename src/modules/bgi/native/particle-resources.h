/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_PARTICLE_RESOURCES_H
#define ML_BGI_PARTICLE_RESOURCES_H
#include "renderer.h"
int MLBGI_AttachParticleResources(Engine_t *engine);
const Bitmap_t *MLBGI_ImageProtocolResource(const Engine_t *engine, uint32_t type, uint32_t slot, uint32_t frame, uint32_t level);
int MLBGI_ImageProtocolInfo(const Engine_t *engine, uint32_t type, uint32_t slot, uint32_t output[3]);
const int32_t *MLBGI_ImageProtocolConfiguration(const Engine_t *engine, uint32_t slot);
const Bitmap_t *MLBGI_ParticleResource(const Engine_t *engine, uint32_t slot, uint32_t level);
const int32_t *MLBGI_ParticleConfiguration(const Engine_t *engine, uint32_t slot);
int MLBGI_DrawParticleResource(const Engine_t *engine, uint32_t slot, uint32_t level, uint8_t *rgba,
                              uint32_t width, uint32_t height, size_t bytes, int32_t x, int32_t y);
#endif

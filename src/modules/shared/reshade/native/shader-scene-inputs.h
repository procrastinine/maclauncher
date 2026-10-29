// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "shader-scene-roles.h"
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Names are authored shader resources. Roles are shared input contracts, never
// inferred from a filename, resource name, provider or renderer.
typedef struct RSShaderSceneBindingV1 {const char*name;uint32_t role,reserved;} RSShaderSceneBindingV1;
// Image roles contain an accessible resolved Metal 2D texture. Depth retains
// actual device-depth values; motion is previous-minus-current normalized UV.
// Normal is signed world XYZ, roughness is linear, and material/radiance color
// retains its declared scene-linear primaries. origin is TopLeft0/BottomLeft1.
// Matrix roles contain sixteen floats in the common row-vector convention.
// Projection Z is normalized to device depth [0,1]; NDC XY maps directly to
// the named images' physical UV as uv=ndc.xy*.5+.5. Actual sample jitter is
// included. A provider flipping image rows reflects projection Y once too.
typedef struct RSShaderSceneValueV1 {
 void*texture;const float*matrix;
 uint32_t width,height,origin,encoding,space,reserved;
} RSShaderSceneValueV1;
// Borrowed only within the synchronous provider prepare/encode call. A provider
// retaining values beyond it calls retain(storage), then release(storage) after
// the actual submitted command buffer completes or is abandoned. The complete
// frame key must match before any resource is bound. No existing frame or node
// vtable layout changes when this optional companion is unavailable.
typedef struct RSShaderSceneInputsV1 {
 uint32_t size,version;
 void*commandBuffer;void*source;void*target;uint64_t frameId;
 uint32_t bindingCount,matrixFlags;
 const RSShaderSceneBindingV1*bindings;
 const RSShaderSceneValueV1*values; // RS_SHADER_SCENE_ROLE_COUNT entries
 void*storage;void(*retain)(void*);void(*release)(void*);
} RSShaderSceneInputsV1;
static inline const RSShaderSceneValueV1*rsShaderSceneValue(const RSShaderSceneInputsV1*p,const char*name){
 if(!p||p->size<sizeof(*p)||p->version!=RS_SHADER_SCENE_ABI_VERSION||!p->values||!p->bindings||p->bindingCount>128||!name)return 0;
 for(uint32_t i=0;i<p->bindingCount;++i){const char*a=p->bindings[i].name,*b=name;if(!a)continue;while(*a&&*a==*b){++a;++b;}if(!*a&&!*b&&p->bindings[i].role<RS_SHADER_SCENE_ROLE_COUNT)return p->values+p->bindings[i].role;}
 return 0;
}
#ifdef __cplusplus
}
#endif

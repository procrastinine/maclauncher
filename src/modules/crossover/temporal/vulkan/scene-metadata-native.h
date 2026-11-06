#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <math.h>
#include <string.h>
#include "scene-metadata.h"
// Native-only projection into the existing ABI1 packets. Texture pointers are
// left null here: the driver resolves each selected image on its actual device.
static inline int rsWineSceneMetadataDecode(const RSWineVulkanSceneRequestV1 *request,
 const RSWineSceneMetadataV2 *metadata,RSSceneAovs *aovs,RSSceneMatrices *matrices) {
 unsigned i;
 if(!request||!metadata||!aovs||!matrices)return 0;
 memset(aovs,0,sizeof(*aovs));memset(matrices,0,sizeof(*matrices));

        if (metadata->size != sizeof(*metadata) || metadata->version != 2 ||
            metadata->aovMask & ~0x3fffu || metadata->matrixFlags & ~63u ||
            (metadata->matrixFlags & 12u) == 12u ||
            (metadata->aovMask << RS_WINE_SCENE_AOV_FIRST & request->imageMask) != metadata->aovMask << RS_WINE_SCENE_AOV_FIRST)
            return 0;
        aovs->size=sizeof(*aovs);aovs->version=1;aovs->frameId=request->frameId;
        aovs->flags=metadata->aovFlags;aovs->viewId=metadata->viewId;aovs->epoch=metadata->epoch;aovs->imageRevision=metadata->imageRevision;
        aovs->preExposure=metadata->preExposure;aovs->pass=metadata->pass;aovs->colorPass=metadata->colorPass;
        memcpy(&aovs->color,&metadata->color,sizeof(aovs->color));
        memcpy(&aovs->uiColor,&metadata->uiColor,sizeof(aovs->uiColor));
        memcpy(&aovs->hudlessColor,&metadata->hudlessColor,sizeof(aovs->hudlessColor));
        for (i=0;i<14;++i) if(metadata->aovMask & (1u<<i)) {
            const RSWineSceneAovImageV2 *source=&metadata->images[i];
            RSSceneAovImage *target=&aovs->images[i];
            if(!request->images[RS_WINE_SCENE_AOV_FIRST+i].image || source->reserved || !source->width || !source->height || source->encoding>5 || source->space>2 || source->channel>3 || source->origin>1 || !isfinite(source->scale) || !isfinite(source->bias))return 0;
            target->x=source->x;target->y=source->y;target->width=source->width;target->height=source->height;
            target->encoding=source->encoding;target->space=source->space;target->channel=source->channel;target->origin=source->origin;
            target->scale=source->scale;target->bias=source->bias;target->pass=source->pass;
        }
        matrices->size=sizeof(*matrices);matrices->version=1;matrices->frameId=request->frameId;matrices->flags=metadata->matrixFlags;
        for(i=0;i<16;++i){
            if(!isfinite(metadata->view[i]) || !isfinite(metadata->projection[i]))return 0;
            matrices->view[i]=metadata->view[i];matrices->projection[i]=metadata->projection[i];
        }

 return 1;
}

// Copyright (c) MacLauncher contributors. MIT license.
#include "denoised-ingress.hpp"
#include "image-color.hpp"
#import <MetalFX/MetalFX.h>
#include <algorithm>
#include <cmath>
#include <limits>
namespace macfx { namespace {
bool image(id<MTLTexture>texture,id<MTLDevice>device,unsigned width,unsigned height){
    return texture&&texture.device==device&&texture.textureType==MTLTextureType2D&&
        texture.sampleCount==1&&texture.width>=width&&texture.height>=height;
}
bool matrixValid(simd_float4x4 matrix){
    for(unsigned column=0;column<4;++column)for(unsigned row=0;row<4;++row)
        if(!std::isfinite(matrix.columns[column][row]))return false;
    const auto inverse=simd_inverse(matrix);
    for(unsigned column=0;column<4;++column)for(unsigned row=0;row<4;++row)
        if(!std::isfinite(inverse.columns[column][row]))return false;
    return true;
}
void rowVectorMatrix(simd_float4x4 source,float*target){
    // SIMD uses column vectors. The shared ABI uses row vectors, so its
    // row-major matrix is the transpose of the SDK's mathematical matrix.
    for(unsigned row=0;row<4;++row)for(unsigned column=0;column<4;++column)
        target[row*4+column]=source.columns[row][column];
}
}
ShaderResult captureDenoisedScalerInputs(id scaler,id<MTLCommandBuffer>commands,
    void*owner,uint64_t frameId,uint32_t optionalMask,RSTemporalFrame&frame,
    RSSceneAovs&packet,RSSceneMatrices&matrices){
    if(@available(macOS 26.0,*)){
        if(!scaler||!commands||!owner||!frameId)return {false,"The native denoiser frame identity is missing"};
        @try { try {
            if(![scaler respondsToSelector:@selector(worldToViewMatrix)]||
                ![scaler respondsToSelector:@selector(shouldResetHistory)]||
                ![scaler respondsToSelector:@selector(diffuseAlbedoTexture)])
                return {false,"The native scaler does not expose denoised scene inputs"};
            const auto description=readImageColor(packet.color);
            if(description.transfer!=ColorTransfer::Linear||!description.sceneReferred)
                return {false,"Native denoising requires the actual linear scene color description"};
            id<MTLFXTemporalDenoisedScalerBase>source=scaler;
            const auto width=source.inputWidth,height=source.inputHeight,
                outputWidth=source.outputWidth,outputHeight=source.outputHeight;
            if(!width||!height||!outputWidth||!outputHeight||
                std::max({width,height,outputWidth,outputHeight})>std::numeric_limits<uint32_t>::max())
                return {false,"The native denoiser extent is invalid"};
            auto device=commands.device;
            id<MTLTexture>color=source.colorTexture,depth=source.depthTexture,
                motion=source.motionTexture,output=source.outputTexture,
                normal=source.normalTexture,roughness=source.roughnessTexture,
                diffuse=source.diffuseAlbedoTexture,specular=source.specularAlbedoTexture;
            for(auto texture:{color,depth,motion,normal,roughness,diffuse,specular})
                if(!image(texture,device,unsigned(width),unsigned(height)))
                    return {false,"The native denoiser scene textures do not match their declared viewport and device"};
            if(!image(output,device,unsigned(outputWidth),unsigned(outputHeight)))
                return {false,"The native denoiser output does not match its declared viewport and device"};
            const auto view=source.worldToViewMatrix,projection=source.viewToClipMatrix;
            if(!matrixValid(view)||!matrixValid(projection))return {false,"The native denoiser matrices are invalid"};
            const float exposure=source.preExposure,jitterX=source.jitterOffsetX,jitterY=source.jitterOffsetY,
                motionX=source.motionVectorScaleX,motionY=source.motionVectorScaleY;
            if(!std::isfinite(exposure)||exposure<=0||!std::isfinite(jitterX)||!std::isfinite(jitterY)||
                !std::isfinite(motionX)||!std::isfinite(motionY))return {false,"The native denoiser exposure or motion convention is invalid"};
            auto next=frame;auto attachments=packet;
            next.size=sizeof(next);next.version=1;next.owner=owner;next.commandBuffer=(__bridge void*)commands;next.frameId=frameId;
            next.color=(__bridge void*)color;next.depth=(__bridge void*)depth;next.motion=(__bridge void*)motion;next.output=(__bridge void*)output;
            next.renderWidth=next.maxRenderWidth=uint32_t(width);next.renderHeight=next.maxRenderHeight=uint32_t(height);
            next.outputWidth=uint32_t(outputWidth);next.outputHeight=uint32_t(outputHeight);
            next.colorX=next.colorY=next.depthX=next.depthY=next.motionX=next.motionY=next.outputX=next.outputY=0;
            next.flags|=RS_TEMPORAL_HDR;
            next.flags=source.depthReversed?next.flags|RS_TEMPORAL_DEPTH_REVERSED:next.flags&~RS_TEMPORAL_DEPTH_REVERSED;
            if(source.shouldResetHistory)next.flags|=RS_TEMPORAL_RESET;
            next.preExposure=exposure;next.jitterX=jitterX;next.jitterY=jitterY;next.motionScaleX=motionX;next.motionScaleY=motionY;
            // Descriptor auto-exposure/reactive choices belong to the caller;
            // an ignored SDK texture must not become an enabled input.
            auto exposureTexture=next.flags&RS_TEMPORAL_AUTO_EXPOSURE?nil:source.exposureTexture;
            if(exposureTexture&&(!image(exposureTexture,device,1,1)||exposureTexture.width!=1||exposureTexture.height!=1))
                return {false,"The native denoiser exposure texture is invalid"};
            next.exposure=(__bridge void*)exposureTexture;
            if(next.reactive&&!image((__bridge id<MTLTexture>)next.reactive,device,unsigned(width),unsigned(height)))
                return {false,"The native denoiser reactive texture is invalid"};
            attachments.size=sizeof(attachments);attachments.version=RS_SCENE_AOV_ABI_VERSION;
            attachments.flags=RS_SCENE_AOV_COLOR_NOISY;attachments.reserved=attachments.reserved2=0;
            attachments.frameId=frameId;if(!attachments.viewId)attachments.viewId=reinterpret_cast<uintptr_t>(owner);
            attachments.preExposure=exposure;attachments.pass=attachments.colorPass=RS_SCENE_AOV_TEMPORAL_INPUT;
            attachments.uiColor={};attachments.hudlessColor={};
            for(auto&value:attachments.images)value={};
            auto bind=[&](unsigned slot,id<MTLTexture>texture,unsigned encoding,unsigned space){
                auto&value=attachments.images[slot];value.texture=(__bridge void*)texture;
                value.width=uint32_t(width);value.height=uint32_t(height);value.encoding=encoding;value.space=space;
                value.origin=RS_SCENE_AOV_TOP_LEFT;value.scale=1;value.pass=RS_SCENE_AOV_TEMPORAL_INPUT;
            };
            bind(RS_SCENE_AOV_NORMAL,normal,RS_SCENE_AOV_XYZ_SIGNED,RS_SCENE_AOV_SPACE_WORLD);
            bind(RS_SCENE_AOV_ROUGHNESS,roughness,RS_SCENE_AOV_SCALAR,RS_SCENE_AOV_SPACE_NONE);
            bind(RS_SCENE_AOV_DIFFUSE_ALBEDO,diffuse,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE);
            bind(RS_SCENE_AOV_SPECULAR_ALBEDO,specular,RS_SCENE_AOV_COLOR,RS_SCENE_AOV_SPACE_NONE);
            for(unsigned slot:{unsigned(RS_SCENE_AOV_SPECULAR_HIT_DISTANCE),unsigned(RS_SCENE_AOV_DENOISE_MASK),unsigned(RS_SCENE_AOV_TRANSPARENCY)}){
                if(!(optionalMask&(uint32_t(1)<<slot)))continue;
                id<MTLTexture>texture=slot==RS_SCENE_AOV_SPECULAR_HIT_DISTANCE?source.specularHitDistanceTexture:
                    slot==RS_SCENE_AOV_DENOISE_MASK?source.denoiseStrengthMaskTexture:source.transparencyOverlayTexture;
                if(!image(texture,device,unsigned(width),unsigned(height)))return {false,"An enabled native denoiser attachment is missing or misaligned"};
                bind(slot,texture,slot==RS_SCENE_AOV_TRANSPARENCY?RS_SCENE_AOV_COLOR:RS_SCENE_AOV_SCALAR,RS_SCENE_AOV_SPACE_NONE);
            }
            next.transparency=attachments.images[RS_SCENE_AOV_TRANSPARENCY].texture;
            RSSceneMatrices transforms{};transforms.size=sizeof(transforms);transforms.version=RS_SCENE_MATRICES_ABI_VERSION;
            transforms.frameId=frameId;transforms.flags=RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID|RS_SCENE_CLIP_ZERO_TO_ONE;
            rowVectorMatrix(view,transforms.view);rowVectorMatrix(projection,transforms.projection);
            frame=next;packet=attachments;matrices=transforms;return {true,{}};
        } catch(const std::exception&error){return {false,error.what()};}
        } @catch(NSException*) {return {false,"The native denoiser inputs could not be read"};}
    }
    return {false,"Native denoised scaling requires macOS 26 or later"};
}
}

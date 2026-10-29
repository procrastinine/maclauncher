// Copyright (c) MacLauncher contributors. MIT license.
#include "metalfx-image-ingress.hpp"
#import <MetalFX/MetalFX.h>
#include <algorithm>
#include <cmath>
#include <limits>
namespace macfx { namespace {
bool dimension(NSUInteger value){return value&&value<=std::numeric_limits<uint32_t>::max();}
bool offset(NSUInteger value){return value<=std::numeric_limits<uint32_t>::max();}
bool image(id<MTLTexture>value,id<MTLDevice>device){
    return value&&value.device==device&&value.textureType==MTLTextureType2D&&value.sampleCount==1&&
        dimension(value.width)&&dimension(value.height);
}
bool region(id<MTLTexture>value,const MetalFxImageRegion&area){
    return value&&area.width&&area.height&&area.x<=value.width&&area.y<=value.height&&
        area.width<=value.width-area.x&&area.height<=value.height-area.y;
}
void retain(MetalFxImageInputs&result,id<MTLTexture>value){
    if(value&&std::find(result.retained.begin(),result.retained.end(),value)==result.retained.end())result.retained.push_back(value);
}
bool matrixValid(simd_float4x4 value){
    for(unsigned c=0;c<4;++c)for(unsigned r=0;r<4;++r)if(!std::isfinite(value.columns[c][r]))return false;
    const auto inverse=simd_inverse(value);
    for(unsigned c=0;c<4;++c)for(unsigned r=0;r<4;++r)if(!std::isfinite(inverse.columns[c][r]))return false;
    return true;
}
void rowMatrix(simd_float4x4 value,float*result){
    // Metal SIMD is column-vector math. Shared matrices use row vectors;
    // row-major storage is the transpose of that mathematical SDK matrix.
    for(unsigned r=0;r<4;++r)for(unsigned c=0;c<4;++c)result[r*4+c]=value.columns[r][c];
}
void sceneReason(MetalFxImageInputs&result,const char*reason){if(result.sceneReason.empty())result.sceneReason=reason;}
ShaderResult captureSpatial(id sdk,id commands,id<MTLDevice>device,void*owner,uint64_t frameId,MetalFxImageInputs&result){
    if(@available(macOS 13.0,*)){
        auto source=(id<MTLFXSpatialScalerBase>)sdk;
        for(SEL selector:{@selector(colorTexture),@selector(outputTexture),@selector(inputContentWidth),@selector(inputContentHeight),
            @selector(inputWidth),@selector(inputHeight),@selector(outputWidth),@selector(outputHeight),@selector(fence)})
            if(![sdk respondsToSelector:selector])return {false,"The native spatial scaler does not expose its image contract"};
        const auto color=source.colorTexture,output=source.outputTexture;
        retain(result,color);retain(result,output);result.fence=source.fence;
        const auto width=source.inputContentWidth,height=source.inputContentHeight,
            inputWidth=source.inputWidth,inputHeight=source.inputHeight,outputWidth=source.outputWidth,outputHeight=source.outputHeight;
        if(!image(color,device)||!image(output,device)||!dimension(width)||!dimension(height)||!dimension(inputWidth)||!dimension(inputHeight)||
            !dimension(outputWidth)||!dimension(outputHeight)||width>inputWidth||height>inputHeight)
            return {false,"The native spatial scaler image extent or device is invalid"};
        result.colorRegion={0,0,uint32_t(width),uint32_t(height)};result.outputRegion={0,0,uint32_t(outputWidth),uint32_t(outputHeight)};
        if(!region(color,result.colorRegion)||!region(output,result.outputRegion))return {false,"The native spatial scaler image region exceeds its texture"};
        auto&frame=result.frame;frame.size=sizeof(frame);frame.version=1;frame.owner=owner;frame.frameId=frameId;
        frame.commandBuffer=(__bridge void*)commands;frame.color=(__bridge void*)color;frame.output=(__bridge void*)output;
        frame.method=RS_TEMPORAL_OFF;frame.renderWidth=uint32_t(width);frame.renderHeight=uint32_t(height);
        frame.maxRenderWidth=uint32_t(inputWidth);frame.maxRenderHeight=uint32_t(inputHeight);
        frame.outputWidth=uint32_t(outputWidth);frame.outputHeight=uint32_t(outputHeight);frame.preExposure=1;
        result.inputWidth=uint32_t(inputWidth);result.inputHeight=uint32_t(inputHeight);
        result.contentWidth=uint32_t(width);result.contentHeight=uint32_t(height);
        return {true,{}};
    }
    return {false,"Native spatial scaling requires macOS 13 or later"};
}
ShaderResult captureInterpolation(id sdk,id commands,id<MTLDevice>device,void*owner,uint64_t frameId,MetalFxImageInputs&result){
    if(@available(macOS 26.0,*)){
        auto source=(id<MTLFXFrameInterpolatorBase>)sdk;
        for(SEL selector:{@selector(colorTexture),@selector(prevColorTexture),@selector(outputTexture),@selector(depthTexture),@selector(motionTexture),
            @selector(inputWidth),@selector(inputHeight),@selector(outputWidth),@selector(outputHeight),@selector(motionVectorScaleX),
            @selector(motionVectorScaleY),@selector(jitterOffsetX),@selector(jitterOffsetY),@selector(deltaTime),@selector(nearPlane),
            @selector(farPlane),@selector(fieldOfView),@selector(aspectRatio),@selector(shouldResetHistory),@selector(isDepthReversed),
            @selector(uiTexture),@selector(isUITextureComposited),@selector(fence)})
            if(![sdk respondsToSelector:selector])return {false,"The native frame interpolator does not expose its image contract"};
        const auto color=source.colorTexture,output=source.outputTexture;
        result.previousColor=source.prevColorTexture;result.depth=source.depthTexture;result.motion=source.motionTexture;
        result.uiColor=source.uiTexture;result.uiComposited=source.isUITextureComposited;result.fence=source.fence;
        for(auto value:{color,output,result.previousColor,result.depth,result.motion,result.uiColor})retain(result,value);
        const auto inputWidth=source.inputWidth,inputHeight=source.inputHeight,outputWidth=source.outputWidth,outputHeight=source.outputHeight;
        if(!image(color,device)||!image(output,device)||!dimension(inputWidth)||!dimension(inputHeight)||!dimension(outputWidth)||!dimension(outputHeight)||
            color.width<outputWidth||color.height<outputHeight||output.width<outputWidth||output.height<outputHeight)
            return {false,"The native frame interpolator color extent or device is invalid"};
        // SDK inputWidth/inputHeight describe the guide images, rather than
        // reconstructed color. Keep the complete composed image authoritative.
        auto&frame=result.frame;frame.size=sizeof(frame);frame.version=1;frame.owner=owner;frame.frameId=frameId;
        frame.commandBuffer=(__bridge void*)commands;frame.color=(__bridge void*)color;frame.output=(__bridge void*)output;
        frame.method=RS_TEMPORAL_METALFX;frame.renderWidth=frame.maxRenderWidth=uint32_t(color.width);
        frame.renderHeight=frame.maxRenderHeight=uint32_t(color.height);frame.outputWidth=uint32_t(output.width);frame.outputHeight=uint32_t(output.height);
        frame.preExposure=1;frame.motionScaleX=source.motionVectorScaleX;frame.motionScaleY=source.motionVectorScaleY;
        frame.jitterX=source.jitterOffsetX;frame.jitterY=source.jitterOffsetY;frame.nearPlane=source.nearPlane;frame.farPlane=source.farPlane;
        const float fov=source.fieldOfView,seconds=source.deltaTime;
        frame.verticalFov=fov*(3.14159265358979323846f/180.f);frame.frameTimeMs=seconds*1000.f;result.aspectRatio=source.aspectRatio;
        if(source.shouldResetHistory)frame.flags|=RS_TEMPORAL_RESET;
        if(source.isDepthReversed)frame.flags|=RS_TEMPORAL_DEPTH_REVERSED;
        if(std::isinf(frame.farPlane)&&frame.farPlane>0)frame.flags|=RS_TEMPORAL_DEPTH_INFINITE;
        if(std::isfinite(frame.nearPlane)&&frame.nearPlane>0&&std::isfinite(fov)&&fov>0&&fov<180&&std::isfinite(result.aspectRatio)&&result.aspectRatio>0&&
            ((std::isfinite(frame.farPlane)&&frame.farPlane>frame.nearPlane)||bool(frame.flags&RS_TEMPORAL_DEPTH_INFINITE)))frame.flags|=RS_TEMPORAL_CAMERA_VALID;
        if(!std::isfinite(frame.jitterX)||!std::isfinite(frame.jitterY)||!std::isfinite(frame.motionScaleX)||!std::isfinite(frame.motionScaleY)||
            !std::isfinite(seconds)||seconds<0)sceneReason(result,"The native frame interpolator motion or timing metadata is invalid");
        result.inputWidth=uint32_t(inputWidth);result.inputHeight=uint32_t(inputHeight);
        result.colorRegion={0,0,uint32_t(color.width),uint32_t(color.height)};
        result.outputRegion={0,0,uint32_t(outputWidth),uint32_t(outputHeight)};
        result.depthRegion={0,0,uint32_t(inputWidth),uint32_t(inputHeight)};result.motionRegion=result.depthRegion;
        if(@available(macOS 27.0,*)){
            if([sdk respondsToSelector:@selector(contentWidth)]&&[sdk respondsToSelector:@selector(contentHeight)]&&
                [sdk respondsToSelector:@selector(depthContentOffsetX)]&&[sdk respondsToSelector:@selector(depthContentOffsetY)]&&
                [sdk respondsToSelector:@selector(motionContentOffsetX)]&&[sdk respondsToSelector:@selector(motionContentOffsetY)]&&
                [sdk respondsToSelector:@selector(outputOffsetX)]&&[sdk respondsToSelector:@selector(outputOffsetY)]){
                const auto width=source.contentWidth,height=source.contentHeight,dx=source.depthContentOffsetX,dy=source.depthContentOffsetY,
                    mx=source.motionContentOffsetX,my=source.motionContentOffsetY,ox=source.outputOffsetX,oy=source.outputOffsetY;
                if(offset(width)&&offset(height)&&offset(dx)&&offset(dy)&&offset(mx)&&offset(my)&&offset(ox)&&offset(oy)){
                    result.contentWidth=uint32_t(width);result.contentHeight=uint32_t(height);
                    result.depthRegion.x=uint32_t(dx);result.depthRegion.y=uint32_t(dy);result.motionRegion.x=uint32_t(mx);result.motionRegion.y=uint32_t(my);
                    result.outputRegion.x=uint32_t(ox);result.outputRegion.y=uint32_t(oy);
                }else sceneReason(result,"The native frame interpolator region exceeds the shared coordinate range");
            }
            if([sdk respondsToSelector:@selector(distortionTexture)]){
                result.distortion=source.distortionTexture;retain(result,result.distortion);
                if(result.distortion&&[sdk respondsToSelector:@selector(distortionOffsetX)]&&[sdk respondsToSelector:@selector(distortionOffsetY)]&&
                    [sdk respondsToSelector:@selector(distortionWidth)]&&[sdk respondsToSelector:@selector(distortionHeight)]){
                    const auto x=source.distortionOffsetX,y=source.distortionOffsetY,w=source.distortionWidth,h=source.distortionHeight;
                    if(offset(x)&&offset(y)&&offset(w)&&offset(h))result.distortionRegion={uint32_t(x),uint32_t(y),uint32_t(w?w:result.contentWidth),uint32_t(h?h:result.contentHeight)};
                    else sceneReason(result,"The native frame interpolator distortion region is invalid");
                }
            }
            if([sdk respondsToSelector:@selector(worldToViewMatrix)]&&[sdk respondsToSelector:@selector(viewToClipMatrix)]){
                const auto view=source.worldToViewMatrix,projection=source.viewToClipMatrix;
                if(matrixValid(view)&&matrixValid(projection)){
                    auto&matrices=result.matrices;matrices.size=sizeof(matrices);matrices.version=RS_SCENE_MATRICES_ABI_VERSION;matrices.frameId=frameId;
                    matrices.flags=RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID;rowMatrix(view,matrices.view);rowMatrix(projection,matrices.projection);result.matricesValid=true;
                }
            }
        }
        const bool matching=image(result.depth,device)&&image(result.motion,device)&&region(result.depth,result.depthRegion)&&region(result.motion,result.motionRegion)&&
            result.depthRegion.width==frame.renderWidth&&result.depthRegion.height==frame.renderHeight&&
            result.motionRegion.width==frame.renderWidth&&result.motionRegion.height==frame.renderHeight&&
            (!result.contentWidth||result.contentWidth==frame.renderWidth)&&(!result.contentHeight||result.contentHeight==frame.renderHeight);
        if(matching&&result.sceneReason.empty()){
            frame.depth=(__bridge void*)result.depth;frame.motion=(__bridge void*)result.motion;
            frame.depthX=result.depthRegion.x;frame.depthY=result.depthRegion.y;frame.motionX=result.motionRegion.x;frame.motionY=result.motionRegion.y;
        }else sceneReason(result,"The native frame interpolator guides require their declared input-to-color region transform");
        if(!region(output,result.outputRegion))sceneReason(result,"The native frame interpolator output region requires explicit content geometry");
        return {true,{}};
    }
    return {false,"Native frame interpolation requires macOS 26 or later"};
}
}}
namespace macfx {
ShaderResult captureMetalFxImageInputs(id sdk,MetalFxImageKind kind,id commands,void*owner,uint64_t frameId,MetalFxImageInputs&output){
    output={};
    if(kind!=MetalFxImageKind::Spatial&&kind!=MetalFxImageKind::Interpolation)return {false,"The native MetalFX image operation is unknown"};
    if(!sdk||!commands||!owner||!frameId||![commands respondsToSelector:@selector(device)])return {false,"The native MetalFX image frame identity or recording context is missing"};
    @try {try {
        const auto device=[(id<MTLCommandBuffer>)commands device];
        if(!device)return {false,"The native MetalFX recording device is missing"};
        MetalFxImageInputs next;
        const auto result=kind==MetalFxImageKind::Spatial?captureSpatial(sdk,commands,device,owner,frameId,next):captureInterpolation(sdk,commands,device,owner,frameId,next);
        if(result.encoded)output=std::move(next);
        return result;
    }catch(const std::exception&error){return {false,error.what()};}}
    @catch(NSException*){return {false,"The native MetalFX image properties could not be captured"};}
}
}

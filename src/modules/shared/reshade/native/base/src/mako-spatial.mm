// SPDX-License-Identifier: GPL-3.0-or-later
#include "mako-spatial.hpp"
#include "metal-vk.hpp"
#include "shaders/spatial_scaling_spirv.hpp"
#include <cmath>
namespace {
template<typename T>std::vector<uint8_t> shaderBytes(const T&words){const auto *begin=reinterpret_cast<const uint8_t*>(words.data());return {begin,begin+words.size()*sizeof(uint32_t)};}
}
struct macfx::MakoSpatialEncoder::Impl {
 id<MTLDevice>device;float sharpness;std::unique_ptr<vk::Shader>rgba8,rgba16;vk::Sampler sampler;
 Impl(id<MTLDevice>d,float value):device(d),sharpness(value){if(!device||!std::isfinite(value)||value<0||value>1)throw std::invalid_argument("Invalid spatial sharpening value");vk::Vulkan host(device);sampler=vk::Sampler(host,2);}
};
macfx::MakoSpatialEncoder::MakoSpatialEncoder(id<MTLDevice>d,float sharpness):impl(std::make_unique<Impl>(d,sharpness)){}
macfx::MakoSpatialEncoder::~MakoSpatialEncoder()=default;
void macfx::MakoSpatialEncoder::encode(id<MTLCommandBuffer>commands,const SpatialFrame&frame){
 auto &shader=frame.output.pixelFormat==MTLPixelFormatRGBA16Float?impl->rgba16:impl->rgba8;
 if(!shader){vk::Vulkan host(impl->device);auto bytes=frame.output.pixelFormat==MTLPixelFormatRGBA16Float?shaderBytes(mako::layer::embedded::spatialScalingRgba16fSpirv):shaderBytes(mako::layer::embedded::spatialScalingRgba8Spirv);shader=std::make_unique<vk::Shader>(host,bytes,0,1,1,1,1);}
 float parameters[]={float(frame.source.width),float(frame.source.height),float(frame.output.width),float(frame.output.height),impl->sharpness,0,0,0};auto encoder=[commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode spatial reconstruction");[encoder setComputePipelineState:shader->pipeline];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.output atIndex:1];[encoder setSamplerState:impl->sampler.object atIndex:0];[encoder setBytes:parameters length:sizeof(parameters) atIndex:0];[encoder dispatchThreads:MTLSizeMake(frame.output.width,frame.output.height,1) threadsPerThreadgroup:shader->group];[encoder endEncoding];
}

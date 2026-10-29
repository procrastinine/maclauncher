// Copyright (c) MacLauncher contributors. MIT license.
#include "color-island.hpp"
#include "scene-matrices.hpp"
#include "image-admission.hpp"
#include <algorithm>
#include <mutex>
#include <stdexcept>
#include <optional>
namespace macfx {
bool sameImageColorDescription(const ImageColorDescription&a,const ImageColorDescription&b)noexcept{return a.primaries==b.primaries&&a.transfer==b.transfer&&a.range==b.range&&a.alpha==b.alpha&&a.referenceWhite==b.referenceWhite&&a.peakLuminance==b.peakLuminance&&a.blackLuminance==b.blackLuminance&&a.hlgSystemGamma==b.hlgSystemGamma&&a.sceneReferred==b.sceneReferred;}
bool imageColorIsHDR(const ImageColorDescription&c)noexcept{return c.transfer==ColorTransfer::PQ||c.transfer==ColorTransfer::HLG||c.peakLuminance>c.referenceWhite;}
bool imageColorNeedsSDRIsland(const ImageColorDescription&c)noexcept{return c.primaries!=ColorPrimaries::BT709||c.transfer!=ColorTransfer::SRGB||c.range!=ColorRange::Full||c.alpha==ColorAlpha::Premultiplied||imageColorIsHDR(c);}
namespace {
id<MTLTexture> texture(id<MTLDevice>device,unsigned w,unsigned h,MTLPixelFormat format){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:w height:h mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;return newAdmittedTexture(device,d,0,"color-island-memory");}
struct Images {__weak id<MTLCommandBuffer>commands=nil;id<MTLTexture>input;std::vector<id<MTLTexture>>outputs;};
}
struct ColorIsland::Impl {
    id<MTLDevice>device;ImageColorDescription source,provider;bool sdr,preserveOpaqueStorage=false;ColorEncoder encoder;std::mutex mutex;std::vector<std::shared_ptr<macfx::Images>>slots;
    Impl(id<MTLDevice>d,const ImageColorDescription&c,bool standard,float white,std::optional<ColorPrimaries>primaries):device(d),source(c),provider(c),sdr(standard),encoder(d){
        if(!source.valid())throw std::runtime_error("The color island requires valid source metadata");
        provider.primaries=sdr?ColorPrimaries::BT709:primaries.value_or(c.primaries);provider.transfer=sdr?ColorTransfer::SRGB:ColorTransfer::Linear;provider.range=ColorRange::Full;provider.alpha=ColorAlpha::Straight;
        if(white>0)provider.referenceWhite=white;
        if(sdr){provider.peakLuminance=provider.referenceWhite;provider.blackLuminance=0;provider.sceneReferred=false;}
    }
    Impl(id<MTLDevice>d,const ImageColorDescription&c,const ImageColorDescription&target):device(d),source(c),provider(target),sdr(false),preserveOpaqueStorage(true),encoder(d){
        if(!source.valid()||!provider.valid()||provider.transfer!=ColorTransfer::Linear||provider.range!=ColorRange::Full||provider.alpha!=ColorAlpha::Straight)
            throw std::runtime_error("The linear color boundary requires valid source and full-range straight linear provider metadata");
    }
    void size(const std::shared_ptr<macfx::Images>&selected,unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count,bool inputRequired,bool retainCapacity){
        const auto format=sdr?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA16Float;
        if(inputRequired&&(!selected->input||selected->input.width!=w||selected->input.height!=h))selected->input=texture(device,w,h,format);
        if(selected->outputs.size()<count||(!retainCapacity&&selected->outputs.size()!=count)||count&&(selected->outputs.front().width!=ow||selected->outputs.front().height!=oh)){
            const auto capacity=retainCapacity?std::max<size_t>(count,selected->outputs.size()):count;
            std::vector<id<MTLTexture>>outputs;for(size_t i=0;i<capacity;++i)outputs.push_back(texture(device,ow,oh,format));selected->outputs=std::move(outputs);
        }
    }
};
ColorIsland::ColorIsland(id<MTLDevice>d,const ImageColorDescription&c,bool sdr,float white,std::optional<ColorPrimaries>primaries):impl(std::make_unique<Impl>(d,c,sdr,white,primaries)){}
ColorIsland::ColorIsland(id<MTLDevice>d,const ImageColorDescription&c,const ImageColorDescription&provider):impl(std::make_unique<Impl>(d,c,provider)){}
ColorIsland::~ColorIsland()=default;
const ImageColorDescription&ColorIsland::providerColor()const{return impl->provider;}
MTLPixelFormat ColorIsland::providerFormat()const{return impl->sdr?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA16Float;}
bool ColorIsland::mapsToDisplay()const{return impl->sdr;}
ShaderResult ColorIsland::prepare(MTLPixelFormat format){const auto input=impl->encoder.prepare(impl->sdr?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA16Float);return input.encoded?impl->encoder.prepare(format):input;}
ColorIsland::Images ColorIsland::acquire(id<MTLCommandBuffer>commands,unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count){return acquire(commands,w,h,ow,oh,count,true);}
ColorIsland::Images ColorIsland::acquire(id<MTLCommandBuffer>commands,unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count,bool inputRequired){
    return acquire(commands,w,h,ow,oh,count,inputRequired,false);
}
ColorIsland::Images ColorIsland::acquire(id<MTLCommandBuffer>commands,unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count,bool inputRequired,bool retainCapacity){
    if(!commands||commands.device!=impl->device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||!w||!h||!ow||!oh||count>4)throw std::runtime_error("The color island requires unsubmitted retaining commands and bounded images");
    std::lock_guard lock(impl->mutex);std::shared_ptr<macfx::Images>selected;
    for(const auto&slot:impl->slots)if(slot->commands==commands){selected=slot;break;}
    if(!selected)for(const auto&slot:impl->slots)if(slot.use_count()==1||(retainCapacity&&slot->commands&&slot->commands.status==MTLCommandBufferStatusCompleted)){selected=slot;break;}
    if(!selected){if(impl->slots.size()>=4)throw ColorIslandBusy("Color conversion command capacity is busy");selected=std::make_shared<macfx::Images>();impl->slots.push_back(selected);}
    impl->size(selected,w,h,ow,oh,count,inputRequired,retainCapacity);
    selected->commands=commands;auto held=selected;[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)held;}];
    return {selected->input,retainCapacity?std::vector<id<MTLTexture>>(selected->outputs.begin(),selected->outputs.begin()+count):selected->outputs,selected};
}
ColorIsland::Images ColorIsland::prepareImages(unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count){
    return prepareImages(w,h,ow,oh,count,true);
}
ColorIsland::Images ColorIsland::prepareImages(unsigned w,unsigned h,unsigned ow,unsigned oh,unsigned count,bool inputRequired){
    if(!w||!h||!ow||!oh||count>4)throw std::runtime_error("Color preparation requires nonempty images and bounded phase capacity");
    std::lock_guard lock(impl->mutex);std::shared_ptr<macfx::Images>selected;
    for(const auto&slot:impl->slots)if(slot.use_count()==1){selected=slot;break;}
    if(!selected){if(impl->slots.size()>=4)throw ColorIslandBusy("Color conversion command capacity is busy");selected=std::make_shared<macfx::Images>();impl->slots.push_back(selected);}
    impl->size(selected,w,h,ow,oh,count,inputRequired,true);selected->commands=nil;
    // Preparation references metadata only, so the slot becomes available as
    // this view retires; no unsubmitted validation command holds it busy.
    return {selected->input,std::vector<id<MTLTexture>>(selected->outputs.begin(),selected->outputs.begin()+count),selected};
}
ShaderResult ColorIsland::enter(id<MTLCommandBuffer>commands,id<MTLTexture>source,const Images&images,uint64_t frameId){return enter(commands,source,images,frameId,false);}
ShaderResult ColorIsland::enter(id<MTLCommandBuffer>commands,id<MTLTexture>source,const Images&images,uint64_t frameId,bool mapped){ColorConversion c;c.source=impl->source;c.target=impl->provider;c.frameId=frameId;if(impl->sdr&&!mapped&&imageColorIsHDR(c.source)&&c.source.peakLuminance>c.target.peakLuminance)c.toneMap=c.source.sceneReferred?ColorToneMap::PBRNeutral:ColorToneMap::Reinhard;return impl->encoder.encode(commands,source,images.input,c);}
ShaderResult ColorIsland::leave(id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,uint64_t frameId,id<MTLTexture>alpha){ColorConversion c;c.source=impl->provider;c.target=impl->source;c.frameId=frameId;c.alphaSource=alpha;if(impl->preserveOpaqueStorage&&c.target.alpha==ColorAlpha::Opaque)c.target.alpha=ColorAlpha::Straight;return impl->encoder.encode(commands,source,target,c);}
namespace {
class Generation final:public GenerationEncoder {
    std::shared_ptr<GenerationEncoder>provider;std::shared_ptr<ColorIsland>island;ImageColorDescription description;std::mutex mutex;RSTemporalFrame scene{};bool hasScene=false,sdr;unsigned capacity=0;
    RSTemporalFrame convertedScene(id<MTLCommandBuffer>commands,id<MTLTexture>color)const{auto value=scene;value.commandBuffer=(__bridge void*)commands;value.color=(__bridge void*)color;if(sdr)value.flags&=~RS_TEMPORAL_HDR;if(auto matrices=temporalSceneMatrices(scene);matrices&&!temporalSceneMatrices(value))rsBindTemporalSceneMatrices(&value,&*matrices);return value;}
    bool identity(id<MTLTexture>source)const{return !sdr&&source.pixelFormat==island->providerFormat()&&sameImageColorDescription(description,island->providerColor());}
public:
    Generation(id<MTLDevice>d,std::shared_ptr<GenerationEncoder>p,const ImageColorDescription&c,bool standard,unsigned count):provider(std::move(p)),island(std::make_shared<ColorIsland>(d,c,standard,!standard&&(std::string_view(provider->method())=="fsr3"||std::string_view(provider->method())=="lsfg")?80.f:0.f,!standard&&(std::string_view(provider->method())=="fsr3"||std::string_view(provider->method())=="lsfg")?std::optional<ColorPrimaries>(ColorPrimaries::BT709):std::nullopt)),description(c),sdr(standard),capacity(count){if(count>4)throw std::runtime_error("Color generation capacity exceeds its bounded phase count");provider->setColorDescription(island->providerColor());}
    const char*method()const noexcept override{return provider->method();}
    ShaderResult preparationStatus()const override{return provider->preparationStatus();}
    bool requiresScene()const noexcept override{return provider->requiresScene();}
    bool gpuTimingAvailable()const override{return provider->gpuTimingAvailable();}
    bool acceptsSynthetic()const noexcept override{return provider->acceptsSynthetic();}
    bool requiresOpaque()const noexcept override{return provider->requiresOpaque();}
    bool outputDisplayMapped(bool input)const noexcept override{return sdr||provider->outputDisplayMapped(input);}
    void setScene(const RSTemporalFrame&value)override{std::lock_guard lock(mutex);scene=value;hasScene=true;}
    void setSceneColorJitter(bool value)override{provider->setSceneColorJitter(value);}
    void setSceneOrigin(FrameOrigin value)override{provider->setSceneOrigin(value);}
    uint64_t imageBytes(unsigned w,unsigned h,const GenerationMeasure&m)const override{return provider->imageBytes(w,h,m);}
    GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>source,const RSTemporalFrame*frame)override{
        GenerationResult result;try{if(identity(source))return provider->prepare(commands,source,frame);const auto ready=island->prepare(source.pixelFormat);if(!ready.encoded){result.reason=ready.reason;return result;}
        auto images=island->prepareImages(source.width,source.height,source.width,source.height,capacity);std::optional<RSTemporalFrame>actual;
        if(frame){actual=*frame;actual->commandBuffer=(__bridge void*)commands;actual->color=(__bridge void*)images.input;if(sdr)actual->flags&=~RS_TEMPORAL_HDR;if(auto matrices=temporalSceneMatrices(*frame);matrices&&!temporalSceneMatrices(*actual))rsBindTemporalSceneMatrices(&*actual,&*matrices);}
        return provider->prepare(commands,images.input,actual?&*actual:nullptr);}catch(const ColorIslandBusy&e){result.busy=true;result.reason=e.what();return result;}
    }
    GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{return encodeColor(commands,source,outputs,sequence,phases,false);}
    GenerationResult encodeColor(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases,bool mapped)override{return encodeColorTimed(commands,source,outputs,sequence,phases,mapped,false);}
    GenerationResult encodeColorTimed(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases,bool mapped,bool measure)override{
        std::lock_guard lock(mutex);GenerationResult result;try{
        if(identity(source)){if(hasScene){provider->setScene(scene);hasScene=false;}return provider->encodeColorTimed(commands,source,outputs,sequence,phases,mapped,measure);}
        // LSFG owns one in-flight command, while multiple timeline pairs may
        // share that same command. Check its actual admission before acquiring
        // or writing another color slot on the render caller.
        if(std::string_view(provider->method())=="lsfg"){result=provider->prepare(commands,source,nullptr);if(!result.encoded)return result;}
        auto images=island->acquire(commands,source.width,source.height,source.width,source.height,unsigned(outputs.size()),true,true);
        const auto input=island->enter(commands,source,images,sequence,mapped);if(!input.encoded){result.reason=input.reason;return result;}
        if(hasScene){auto actual=convertedScene(commands,images.input);provider->setScene(actual);hasScene=false;}
        result=provider->encodeColorTimed(commands,images.input,images.outputs,sequence,phases,false,measure);if(!result.encoded)return result;
        if(result.ready)for(unsigned i=0;i<result.generated&&i<outputs.size();++i){const auto output=island->leave(commands,images.outputs[i],outputs[i],sequence);if(!output.encoded){result.encoded=false;result.reason=output.reason;return result;}}
        return result;}catch(const ColorIslandBusy&e){result.busy=true;result.reason=e.what();return result;}catch(const ImageBudgetExceeded&e){result.busy=true;result.reason=e.what();return result;}
    }
};
}
std::shared_ptr<GenerationEncoder>makeColorIslandGenerationEncoder(id<MTLDevice>d,std::shared_ptr<GenerationEncoder>provider,const ImageColorDescription&c,bool sdr){return makeColorIslandGenerationEncoder(d,std::move(provider),c,sdr,0);}
std::shared_ptr<GenerationEncoder>makeColorIslandGenerationEncoder(id<MTLDevice>d,std::shared_ptr<GenerationEncoder>provider,const ImageColorDescription&c,bool sdr,unsigned capacity){return std::make_shared<Generation>(d,std::move(provider),c,sdr,capacity);}
}

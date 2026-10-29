// Copyright (c) MacLauncher contributors. MIT license.
// Original FidelityFX Lens: Copyright (C) 2024 Advanced Micro Devices, Inc.
// See ffx-lens-MIT.txt.
#include "ffx-lens.hpp"
#include "ffx-lens-shaders.hpp"
#include "ffx-lens-upstream.hpp"
#include "ffx-image-filter.hpp"
#include <cmath>
namespace macfx {namespace {
static_assert(sizeof(ffx_lens_host::LensConstants)==32);
struct Settings {
 float grainScale=1,grainAmount=.15f,chromatic=.25f,vignette=.2f;uint32_t seed=0;bool animate=true,hasColor=false;ImageColorDescription color;
 bool identity()const{return grainAmount==0&&chromatic==0&&vignette==0;}
};
Settings settings(const ShaderParameters&parameters){Settings s;for(const auto&[name,values]:parameters){
 if(values.size()!=1||!std::isfinite(values[0]))throw std::invalid_argument("FidelityFX Lens controls require finite scalar values");const float v=values[0];
 if(name=="GrainScale"&&v>=.25f&&v<=64)s.grainScale=v;
 else if(name=="GrainAmount"&&v>=0&&v<=1)s.grainAmount=v;
 else if(name=="ChromaticAberration"&&v>=0&&v<=10)s.chromatic=v;
 else if(name=="Vignette"&&v>=0&&v<=2)s.vignette=v;
 else if(name=="GrainSeed"&&v>=0&&v<=16777215&&std::floor(v)==v)s.seed=uint32_t(v);
 else if(name=="AnimateGrain"&&(v==0||v==1))s.animate=v!=0;
 else throw std::invalid_argument("Invalid FidelityFX Lens control");
 }return s;}
class Lens final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<ffx_image::Resources>state;std::shared_ptr<ffx_image::Flight>last;std::mutex preparation;
public:
 explicit Lens(const ShaderParameters&p):options(std::make_shared<Settings>(settings(p))){}
 void setParameters(const ShaderParameters&p)override{auto next=settings(p),old=*std::atomic_load(&options);next.color=old.color;next.hasColor=old.hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid FidelityFX Lens image color description");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<Lens>fork(const ShaderParameters&p){auto next=std::make_shared<Lens>(p);next->state=std::atomic_load(&state);auto value=std::make_shared<Settings>(*next->options);auto old=std::atomic_load(&options);value->color=old->color;value->hasColor=old->hasColor;next->options=value;return next;}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto reason=ffx_image::validate(f);!reason.empty())return{false,reason,false};auto setting=std::atomic_load(&options);
  if(!setting->identity()&&(f.source.width<2||f.source.height<2))return{false,"The original FidelityFX Lens optical center requires at least two pixels per image axis",false};
  auto color=ffx_image::inputColor(f,setting->hasColor,setting->color);std::lock_guard guard(preparation);auto old=std::atomic_load(&state);const auto&shader=ffx_lens_shaders::shaders[0];if(old&&old->matches(f,color,shader.name))return{true,{}};
  auto next=ffx_image::resources();next->prepare(f,color,shader);std::atomic_store(&state,next);return{true,{}};
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return{false,e.what(),false};}}
 ShaderResult encode(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto reason=ffx_image::validate(f);!reason.empty())return{false,reason,false};auto setting=std::atomic_load(&options);auto color=ffx_image::inputColor(f,setting->hasColor,setting->color);const auto&shader=ffx_lens_shaders::shaders[0];auto r=std::atomic_load(&state);
  if(!r||!r->matches(f,color,shader.name))return{false,"FidelityFX Lens resources are preparing for this image",true};
  if(!setting->identity()&&(r->width<2||r->height<2))return{false,"The original FidelityFX Lens optical center requires at least two pixels per image axis",false};
  auto flight=ffx_image::begin(f,r);std::atomic_store(&last,flight);
  if(setting->identity()){
   if(f.source.pixelFormat!=f.target.pixelFormat)return r->leave(f,true);auto copy=[f.commands blitCommandEncoder];if(!copy)return{false,"Cannot encode the FidelityFX Lens identity copy",false};[copy copyFromTexture:f.source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)sourceSize:MTLSizeMake(r->width,r->height,1)toTexture:f.target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];return{true,{}};
  }
  auto entered=r->enter(f);if(!entered.encoded)return entered;
  ffx_lens_host::LensConstants constants{};constants.grainScale=setting->grainScale;constants.grainAmount=setting->grainAmount;constants.grainSeed=setting->seed^(setting->animate?uint32_t(f.frameId):0);constants.center[0]=r->width/2;constants.center[1]=r->height/2;constants.chromAb=setting->chromatic;constants.vignette=setting->vignette;
  ffx_image::dispatch(f,r,shader,constants,ffx_lens_host::dispatch(r->width,r->height),"r_input_texture","rw_output_texture");return r->leave(f);
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return{false,e.what(),false};}}
 std::function<ShaderResult()>ticket()const{auto flight=std::atomic_load(&last);return flight?[flight]{return flight->completion();}:std::function<ShaderResult()>{};}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeFfxLensNode(const ShaderParameters&p){return std::make_shared<Lens>(p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkFfxLensNode(const std::shared_ptr<ShaderNode>&node,const ShaderParameters&p){auto value=std::dynamic_pointer_cast<Lens>(node);return value?value->fork(p):nullptr;}
void macfx::setFfxLensNodeColor(const std::shared_ptr<ShaderNode>&node,const ImageColorDescription&c){if(auto value=std::dynamic_pointer_cast<Lens>(node))value->setColor(c);}
std::function<macfx::ShaderResult()>macfx::ffxLensCompletionTicket(const std::shared_ptr<ShaderNode>&node){auto value=std::dynamic_pointer_cast<Lens>(node);return value?value->ticket():std::function<ShaderResult()>{};}
macfx::ShaderResult macfx::finishFfxLensNode(const std::shared_ptr<ShaderNode>&node){auto ticket=ffxLensCompletionTicket(node);return ticket?ticket():ShaderResult{true,{}};}

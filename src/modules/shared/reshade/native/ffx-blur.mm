// Copyright (c) MacLauncher contributors. MIT license.
// Original FidelityFX Blur: Copyright (C) 2024 Advanced Micro Devices, Inc.
// See ffx-blur-MIT.txt.
#include "ffx-blur.hpp"
#include "ffx-blur-shaders.hpp"
#include "ffx-blur-upstream.hpp"
#include "ffx-image-filter.hpp"
#include <cmath>
namespace macfx {namespace {
static_assert(sizeof(ffx_blur_host::BlurConstants)==8);
static_assert(sizeof(ffx_blur_shaders::shaders)/sizeof(ffx_blur_shaders::Shader)==30);
struct Settings {unsigned kernel=9,sigma=1;bool hasColor=false;ImageColorDescription color;};
Settings settings(const ShaderParameters&p){Settings s;for(const auto&[name,values]:p){
 if(values.size()!=1||!std::isfinite(values[0]))throw std::invalid_argument("FidelityFX Blur controls require finite scalar values");const float v=values[0];
 if(name=="KernelSize"&&v>=3&&v<=21&&std::floor(v)==v&&(unsigned(v)&1))s.kernel=unsigned(v);
 else if(name=="SigmaPreset"&&v>=0&&v<=2&&std::floor(v)==v)s.sigma=unsigned(v);
 else throw std::invalid_argument("Invalid FidelityFX Blur kernel or sigma preset");
 }return s;}
const ffx_blur_shaders::Shader&shader(const Settings&s){return ffx_blur_shaders::shaders[((s.kernel-3)/2)*3+s.sigma];}
class Blur final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<ffx_image::Resources>state;std::shared_ptr<ffx_image::Flight>last;std::mutex preparation;
public:
 explicit Blur(const ShaderParameters&p):options(std::make_shared<Settings>(settings(p))){}
 void setParameters(const ShaderParameters&p)override{auto next=settings(p),old=*std::atomic_load(&options);next.color=old.color;next.hasColor=old.hasColor;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&c){if(!c.valid())throw std::invalid_argument("Invalid FidelityFX Blur image color description");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->color=c;next->hasColor=true;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<Blur>fork(const ShaderParameters&p){auto next=std::make_shared<Blur>(p);next->state=std::atomic_load(&state);auto value=std::make_shared<Settings>(*next->options);auto old=std::atomic_load(&options);value->color=old->color;value->hasColor=old->hasColor;next->options=value;return next;}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto reason=ffx_image::validate(f);!reason.empty())return{false,reason,false};auto setting=std::atomic_load(&options);auto c=ffx_image::inputColor(f,setting->hasColor,setting->color);std::lock_guard guard(preparation);auto old=std::atomic_load(&state);const auto&kernel=shader(*setting);if(old&&old->matches(f,c,kernel.name))return{true,{}};auto next=ffx_image::resources();next->prepare(f,c,kernel);std::atomic_store(&state,next);return{true,{}};
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return{false,e.what(),false};}}
 ShaderResult encode(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto reason=ffx_image::validate(f);!reason.empty())return{false,reason,false};auto setting=std::atomic_load(&options);auto c=ffx_image::inputColor(f,setting->hasColor,setting->color);const auto&kernel=shader(*setting);auto r=std::atomic_load(&state);if(!r||!r->matches(f,c,kernel.name))return{false,"FidelityFX Blur resources are preparing for this kernel and image",true};
  auto flight=ffx_image::begin(f,r);std::atomic_store(&last,flight);auto entered=r->enter(f);if(!entered.encoded)return entered;ffx_blur_host::BlurConstants constants{r->width,r->height};
  ffx_image::dispatch(f,r,kernel,constants,ffx_blur_host::dispatch(r->width,r->height),"r_input_src","rw_output");return r->leave(f);
 }}catch(const ImageBudgetExceeded&){throw;}catch(const std::exception&e){return{false,e.what(),false};}}
 std::function<ShaderResult()>ticket()const{auto flight=std::atomic_load(&last);return flight?[flight]{return flight->completion();}:std::function<ShaderResult()>{};}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeFfxBlurNode(const ShaderParameters&p){return std::make_shared<Blur>(p);}
std::shared_ptr<macfx::ShaderNode>macfx::forkFfxBlurNode(const std::shared_ptr<ShaderNode>&node,const ShaderParameters&p){auto value=std::dynamic_pointer_cast<Blur>(node);return value?value->fork(p):nullptr;}
void macfx::setFfxBlurNodeColor(const std::shared_ptr<ShaderNode>&node,const ImageColorDescription&c){if(auto value=std::dynamic_pointer_cast<Blur>(node))value->setColor(c);}
std::function<macfx::ShaderResult()>macfx::ffxBlurCompletionTicket(const std::shared_ptr<ShaderNode>&node){auto value=std::dynamic_pointer_cast<Blur>(node);return value?value->ticket():std::function<ShaderResult()>{};}
macfx::ShaderResult macfx::finishFfxBlurNode(const std::shared_ptr<ShaderNode>&node){auto ticket=ffxBlurCompletionTicket(node);return ticket?ticket():ShaderResult{true,{}};}

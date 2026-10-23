#include "uniform-sources.hpp"
#include <cassert>
#include <cstdio>
#include <tuple>

using T=reshadefx::type;
static reshadefx::annotation text(const char *name,const char *value){reshadefx::annotation a;a.name=name;a.type.base=T::t_string;a.value.string_data=value;return a;}
static reshadefx::annotation number(const char *name,float value){reshadefx::annotation a;a.name=name;a.type.base=T::t_float;a.type.rows=a.type.cols=1;a.value.as_float[0]=value;return a;}
static void add(macfx::Effect &e,const char *source,T::datatype type,unsigned count){reshadefx::uniform u;u.type.base=type;u.type.rows=count;u.type.cols=1;u.offset=e.uniforms.size();u.annotations.push_back(text("source",source));e.module.uniforms.push_back(u);e.uniforms.resize(e.uniforms.size()+count*4);}
template<class V> static V at(const macfx::Effect &e,size_t index){V v;std::memcpy(&v,e.uniforms.data()+index*4,4);return v;}
int main(){
 macfx::Effect effect;add(effect,"pingpong",T::t_float,2);auto &ping=effect.module.uniforms.back();ping.annotations.push_back(number("step",2));
 add(effect,"framecount",T::t_float,1);add(effect,"framecount",T::t_bool,1);add(effect,"timer",T::t_uint,1);add(effect,"frametime",T::t_float,1);
 macfx::UniformSources sources;sources.configure(effect);sources.update(effect,750,250,42);
 assert(at<float>(effect,0)==.5f&&at<float>(effect,1)==0);assert(at<float>(effect,2)==42.f);assert(at<uint32_t>(effect,3)==1);assert(at<uint32_t>(effect,4)==750);assert(at<float>(effect,5)==250.f);
 sources.update(effect,1000,250,43);assert(at<float>(effect,0)==1&&at<float>(effect,1)==-1);assert(at<uint32_t>(effect,3)==0);
 sources.update(effect,1250,250,44);assert(at<float>(effect,0)==.5f&&at<float>(effect,1)==-1);
 sources.update(effect,1750,500,45);assert(at<float>(effect,0)==0&&at<float>(effect,1)==1);
 // Independent owners retain independent animation, and non-frame reads do not advance it.
 macfx::Effect other=effect;std::fill(other.uniforms.begin(),other.uniforms.end(),0);macfx::UniformSources independent;independent.configure(other);independent.update(other,10,50,0);assert(std::abs(at<float>(other,0)-.1f)<.00001f);assert(at<float>(effect,0)==0);
 macfx::Effect noise;add(noise,"random",T::t_int,1);noise.module.uniforms.back().annotations.push_back(number("min",-4));noise.module.uniforms.back().annotations.push_back(number("max",-2));sources.configure(noise);
 for(unsigned i=0;i<100;++i){sources.update(noise,i,16,i);assert(at<int32_t>(noise,0)>=-4&&at<int32_t>(noise,0)<=-2);}
 macfx::Effect overlay;add(overlay,"overlay_active",T::t_int,1);add(overlay,"overlay_active",T::t_bool,1);add(overlay,"framecount",T::t_uint,1);
 std::fill(overlay.uniforms.begin(),overlay.uniforms.end(),0xff);sources.configure(overlay);
 for(unsigned frame:{0u,1u,60u}){sources.update(overlay,frame*16,16,frame);assert(at<int32_t>(overlay,0)==0&&at<uint32_t>(overlay,1)==0);assert(at<uint32_t>(overlay,2)==frame);}
 macfx::Effect controls;add(controls,"timer",T::t_float,1);
 for(const auto &[name,type,count]:{std::tuple<const char*,T::datatype,unsigned>{"Enabled",T::t_bool,1},{"Mode",T::t_int,1},{"Tint",T::t_float,3}}){
   add(controls,"",type,count);auto &u=controls.module.uniforms.back();u.annotations.clear();u.unique_name=name;
 }
 const uint32_t enabled=1;const int32_t mode=4;const float tint[]={.2f,.4f,.6f};
 std::memcpy(controls.uniforms.data()+4,&enabled,4);std::memcpy(controls.uniforms.data()+8,&mode,4);std::memcpy(controls.uniforms.data()+12,tint,sizeof(tint));
 sources.configure(controls);sources.update(controls,123,16,0);
 sources.setParameters(controls,{{"Enabled",{0}},{"Mode",{7}},{"Tint",{.1f,.3f,.5f}},{"timer",{0}}});
 assert(at<float>(controls,0)==123&&at<uint32_t>(controls,1)==0&&at<int32_t>(controls,2)==7);
 assert(at<float>(controls,3)==.1f&&at<float>(controls,4)==.3f&&at<float>(controls,5)==.5f);
 sources.setParameters(controls,{});sources.update(controls,456,16,1);
 assert(at<float>(controls,0)==456&&at<uint32_t>(controls,1)==1&&at<int32_t>(controls,2)==4);
 assert(at<float>(controls,3)==.2f&&at<float>(controls,4)==.4f&&at<float>(controls,5)==.6f);
 puts("Per-node parameters: typed bool/int/vector updates and removal reset preserve original animated sources");
 puts("Uniform sources: ping-pong endpoints and direction, typed counters, independent state, bounded random, inactive native overlay and Royale mask refresh counters passed");
}

#pragma once
#include "effect.hpp"
#include "live-controls.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <ctime>
#include <limits>
#include <random>
#include <stdexcept>

namespace macfx {
// Per-effect animation state. Source annotations are resolved once after
// compilation, and each source advances once per frame, regardless of passes.
class UniformSources {
    enum class Kind { Timer, FrameTime, FrameCount, PingPong, Random, Date, DepthReady, OverlayActive };
    struct Entry {
        Kind kind; unsigned offset, count; reshadefx::type type;
        float minimum=0,maximum=1,step=0,stepMax=0,smoothing=0;
        float value=0,direction=0;
    };
    std::vector<Entry> entries;
    struct Parameter {std::string name;Entry entry;std::array<unsigned char,16> initial{};};
    std::vector<Parameter> parameters;
    std::string expectedKey;uint64_t appliedControls=~uint64_t(0);bool refreshParameters=true;
    std::minstd_rand random{1};
    static float annotation(const reshadefx::uniform &u,const char *name,unsigned index=0,float fallback=0) {
        for(const auto &a:u.annotations)if(a.name==name&&index<a.type.components())
            return a.type.is_floating_point()?a.value.as_float[index]:
                a.type.is_unsigned()?float(a.value.as_uint[index]):float(a.value.as_int[index]);
        return fallback;
    }
    static void write(const Entry &entry,unsigned char *out,unsigned index,double value) {
        if(index>=entry.count)return;
        if(entry.type.is_floating_point()){const float v=value;std::memcpy(out+entry.offset+index*4,&v,4);}
        else if(entry.type.is_boolean()){const uint32_t v=value!=0;std::memcpy(out+entry.offset+index*4,&v,4);}
        else if(entry.type.is_unsigned()){const uint32_t v=std::clamp(value,0.0,double(UINT32_MAX));std::memcpy(out+entry.offset+index*4,&v,4);}
        else {const int32_t v=std::clamp(value,double(INT32_MIN),double(INT32_MAX));std::memcpy(out+entry.offset+index*4,&v,4);}
    }
public:
    void setParameters(Effect &effect,const std::map<std::string,std::vector<float>> &values) {
        for(const auto &p:parameters) {
            std::memcpy(effect.uniforms.data()+p.entry.offset,p.initial.data(),p.entry.count*4);
            const auto found=values.find(p.name);
            if(found==values.end()||found->second.size()!=p.entry.count)continue;
            for(unsigned c=0;c<p.entry.count;++c)if(std::isfinite(found->second[c]))
                write(p.entry,effect.uniforms.data(),c,found->second[c]);
        }
    }
    void configure(const Effect &effect,const std::string &key={}) {
        expectedKey=key;
        entries.clear();parameters.clear();refreshParameters=true;bool needsRandom=false;
        for(const auto &u:effect.module.uniforms){
            if(std::any_of(u.annotations.begin(),u.annotations.end(),[](const auto&a){return a.name=="source";})||
               !u.type.components()||u.type.components()>4||u.type.array_length||u.offset+u.type.components()*4>effect.uniforms.size())continue;
            Parameter p;p.name=u.unique_name;p.entry={Kind::Timer,u.offset,u.type.components(),u.type};
            std::memcpy(p.initial.data(),effect.uniforms.data()+u.offset,u.type.components()*4);parameters.push_back(p);
        }
        for(const auto &u:effect.module.uniforms)for(const auto &a:u.annotations)if(a.name=="source") {
            const auto &name=a.value.string_data;
            const Kind kind=name=="timer"?Kind::Timer:name=="frametime"?Kind::FrameTime:
                name=="framecount"?Kind::FrameCount:name=="pingpong"?Kind::PingPong:
                name=="random"?Kind::Random:name=="date"?Kind::Date:name=="bufready_depth"?Kind::DepthReady:
                name=="overlay_active"?Kind::OverlayActive:
                throw std::runtime_error("Unsupported uniform source: "+name);
            if(!u.type.components()||u.type.components()>4||u.offset+u.type.components()*4>effect.uniforms.size())
                throw std::runtime_error("Invalid source uniform storage");
            Entry entry{kind,u.offset,u.type.components(),u.type};
            entry.minimum=annotation(u,"min");entry.maximum=annotation(u,"max",0,kind==Kind::Random?float(RAND_MAX):1);
            entry.step=annotation(u,"step");entry.stepMax=annotation(u,"step",1);entry.smoothing=annotation(u,"smoothing");
            needsRandom|=kind==Kind::Random||(kind==Kind::PingPong&&entry.stepMax!=0);
            if(kind==Kind::PingPong){
                if(!u.type.is_floating_point()||entry.count!=2)throw std::runtime_error("Ping-pong sources require float2 storage");
                std::memcpy(&entry.value,effect.uniforms.data()+u.offset,4);
                std::memcpy(&entry.direction,effect.uniforms.data()+u.offset+4,4);
                if(!std::isfinite(entry.minimum)||!std::isfinite(entry.maximum)||entry.maximum<entry.minimum||
                   !std::isfinite(entry.step)||!std::isfinite(entry.stepMax)||!std::isfinite(entry.smoothing)||
                   (entry.stepMax!=0&&entry.stepMax-entry.step+1<=0))
                    throw std::runtime_error("Invalid ping-pong source range");
            }
            entries.push_back(entry);
        }
        if(needsRandom)random.seed(std::random_device{}());
    }
    void update(Effect &effect,double elapsedMilliseconds,float frameMilliseconds,uint64_t frame,bool depthAvailable=false) {
        auto *out=effect.uniforms.data();
        const auto &state=liveState();const auto packet=state.controls.get();
        const bool controlsChanged=appliedControls!=state.generation;appliedControls=state.generation;
        const bool matches=packet&&expectedKey.size()==64&&!std::memcmp(expectedKey.data(),packet->effectKey,64);
        if(refreshParameters||(controlsChanged&&matches)){
            refreshParameters=false;
            for(const auto&p:parameters){std::memcpy(out+p.entry.offset,p.initial.data(),p.entry.count*4);
                if(!matches)continue;
                for(unsigned i=0;i<packet->count;++i){const auto &u=packet->uniforms[i];
                    if(p.name==u.name&&p.entry.count==u.count){for(unsigned c=0;c<u.count;++c)write(p.entry,out,c,u.values[c]);break;}
                }
            }
        }
        for(auto &e:entries)switch(e.kind) {
            case Kind::Timer:write(e,out,0,elapsedMilliseconds);break;
            case Kind::FrameTime:write(e,out,0,frameMilliseconds);break;
            case Kind::FrameCount:write(e,out,0,e.type.is_boolean()?double(frame%2==0):double(frame%UINT32_MAX));break;
            case Kind::DepthReady:write(e,out,0,depthAvailable);break;
            // Settings live in a separate launcher window. The native runtime
            // has no in-game ReShade overlay, so its active state is zero.
            case Kind::OverlayActive:write(e,out,0,0);break;
            case Kind::Random:{
                const auto lo=int64_t(std::clamp(double(e.minimum),double(INT32_MIN),double(INT32_MAX)));
                const auto hi=int64_t(std::clamp(double(e.maximum),double(INT32_MIN),double(INT32_MAX)));
                write(e,out,0,std::uniform_int_distribution<int64_t>(std::min(lo,hi),std::max(lo,hi))(random));break;
            }
            case Kind::Date:{
                const time_t current=std::time(nullptr);tm local{};
                if(!localtime_r(&current,&local))throw std::runtime_error("Cannot read local date for the selected effect");
                write(e,out,0,local.tm_year+1900);write(e,out,1,local.tm_mon+1);write(e,out,2,local.tm_mday);
                write(e,out,3,local.tm_hour*3600+local.tm_min*60+local.tm_sec);break;
            }
            case Kind::PingPong:{
                // ReShade's step/smoothing and endpoint direction convention.
                const float range=e.stepMax-e.step+1;
                float increment=e.stepMax==0?e.step:e.step+std::fmod(float(random()),range);
                const float remaining=e.direction>=0?e.maximum-e.value:e.value-e.minimum;
                increment=std::max(increment-std::max(0.f,e.smoothing-remaining),.05f)*std::max(frameMilliseconds,0.f)*.001f;
                if(e.direction>=0){e.value+=increment;if(e.value>=e.maximum){e.value=e.maximum;e.direction=-1;}}
                else {e.value-=increment;if(e.value<=e.minimum){e.value=e.minimum;e.direction=1;}}
                write(e,out,0,e.value);write(e,out,1,e.direction);break;
            }
        }
    }
};
}

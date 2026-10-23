#pragma once
#include "remote-ingress-diagnostics.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cerrno>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace macfx {
// Little-endian, fixed-size records written atomically by the launcher. Files
// are read-only in the game. No pointers, commands or shader paths are accepted.
struct LiveUniform {char name[128];uint32_t count;float values[4];};
struct LivePacket {char magic[8];uint32_t targetHz,multiplier,flags,count;char effectKey[64],revision[64];
    uint32_t spatial;float sharpness;uint32_t ls1Mode,lsfgMode;float flowScale=1;LiveUniform uniforms[128];};
static_assert(sizeof(LivePacket)==19116);
class LiveControls {
    std::chrono::steady_clock::time_point next{};
    std::array<char,64> expected{};
    LivePacket packet{};bool loaded=false;
    ino_t inode=0;timespec modified{};
public:
    LiveControls(){const auto key=std::getenv("RESHADE_EFFECT_KEY");if(key&&std::strlen(key)==64)std::memcpy(expected.data(),key,64);}
    bool poll(){return poll(false);}
    bool poll(bool force){
        const auto now=std::chrono::steady_clock::now();if(!force&&now<next)return false;
        next=now+std::chrono::milliseconds(100);
        const bool observe=remoteIngressDiagnostics::active();
        if(observe){auto &d=liveControlPollDiagnosticState();++d.attempts;d.reader=reinterpret_cast<uintptr_t>(this);d.uniformIndex=UINT32_MAX;}
        const auto finish=[&](LiveControlPollResult result,int error=0,bool changed=false,unsigned index=UINT32_MAX){
            if(observe){auto &d=liveControlPollDiagnosticState();d.result=result;d.error=error;d.uniformIndex=index;d.loaded=loaded;d.flags=loaded?packet.flags:0;}
            return changed;
        };
        const auto file=std::getenv("RESHADE_CONTROL_FILE");if(!file||!*file)return finish(LiveControlPollResult::NoPath);
        const int fd=open(file,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return finish(LiveControlPollResult::OpenFailed,errno);
        struct stat info{};LivePacket incoming{};
        const int statStatus=fstat(fd,&info),statError=statStatus<0?errno:0;
        const bool regular=statStatus==0&&S_ISREG(info.st_mode)&&info.st_size==sizeof(incoming);
        if(regular&&loaded&&inode==info.st_ino&&modified.tv_sec==info.st_mtimespec.tv_sec&&modified.tv_nsec==info.st_mtimespec.tv_nsec){close(fd);return finish(LiveControlPollResult::Unchanged);}
        const auto length=regular?pread(fd,&incoming,sizeof(incoming),0):ssize_t(-1);const int readError=regular&&length<0?errno:0;close(fd);
        if(statStatus<0)return finish(LiveControlPollResult::FstatFailed,statError);
        if(!S_ISREG(info.st_mode))return finish(LiveControlPollResult::NotRegular);
        if(info.st_size!=sizeof(incoming))return finish(LiveControlPollResult::WrongSize);
        if(length<0)return finish(LiveControlPollResult::PreadFailed,readError);
        if(length!=sizeof(incoming))return finish(LiveControlPollResult::ShortRead);
        if(std::memcmp(incoming.magic,"MLFXCTL2",8))return finish(LiveControlPollResult::Magic);
        if(incoming.targetHz<30||incoming.targetHz>240)return finish(LiveControlPollResult::TargetRate);
        if(incoming.multiplier<2||incoming.multiplier>5)return finish(LiveControlPollResult::Multiplier);
        if(incoming.flags>63)return finish(LiveControlPollResult::Flags);
        if(incoming.count>128)return finish(LiveControlPollResult::UniformCount);
        if(incoming.spatial>7)return finish(LiveControlPollResult::Spatial);
        if(!std::isfinite(incoming.sharpness)||incoming.sharpness<0||incoming.sharpness>1)return finish(LiveControlPollResult::Sharpness);
        if(incoming.ls1Mode>1)return finish(LiveControlPollResult::LS1Mode);
        if(incoming.lsfgMode>3)return finish(LiveControlPollResult::LSFGMode);
        if(!std::isfinite(incoming.flowScale)||incoming.flowScale<.25||incoming.flowScale>1)return finish(LiveControlPollResult::FlowScale);
        for(unsigned i=0;i<incoming.count;++i){const auto &u=incoming.uniforms[i];
            if(!std::memchr(u.name,0,sizeof(u.name)))return finish(LiveControlPollResult::UniformName,0,false,i);
            if(u.count<1||u.count>4)return finish(LiveControlPollResult::UniformComponents,0,false,i);
            for(unsigned c=0;c<u.count;++c)if(!std::isfinite(u.values[c]))return finish(LiveControlPollResult::UniformValue,0,false,i);
        }
        const bool changed=!loaded||std::memcmp(&packet,&incoming,sizeof(packet));packet=incoming;loaded=true;inode=info.st_ino;modified=info.st_mtimespec;return finish(LiveControlPollResult::Accepted,0,changed);
    }
    const LivePacket *get()const{return loaded?&packet:nullptr;}
    void setEffectKey(const std::string &key){if(key.size()==64)std::memcpy(expected.data(),key.data(),64);}
    bool matchesEffect()const{return loaded&&!std::memcmp(expected.data(),packet.effectKey,64);}
};
// Each producer thread polls at most ten times per second; readers never share
// mutable packet storage and render calls use a stable selection snapshot.
struct LiveState {LiveControls controls;uint64_t generation=0;};
inline LiveState &liveStateStorage(){thread_local LiveState state;return state;}
inline unsigned &liveStatePinDepth(){thread_local unsigned depth=0;return depth;}
inline LiveState &readLiveState(bool force){auto &state=liveStateStorage();
    if(!liveStatePinDepth()&&state.controls.poll(force)){
        // Parameter caches belong to owners that may receive frames on more
        // than one producer thread. Different accepted readers must not both
        // look like generation 1 to those caches. Unchanged bytes cost no RMW.
        static std::atomic<uint64_t> sequence{0};state.generation=sequence.fetch_add(1,std::memory_order_relaxed)+1;
    }
    if(remoteIngressDiagnostics::active()){auto &d=liveControlPollDiagnosticState();if(d.reader==reinterpret_cast<uintptr_t>(&state.controls))d.generation=state.generation;}
    return state;}
inline LiveState &liveState(){return readLiveState(false);}
inline LiveState &refreshLiveState(){return readLiveState(true);}
// Only synchronous held encoding pins a reader. Nested preparation, uniforms
// and stamping see exactly that packet; every return/exception releases it.
class LiveStatePin {
    bool active;
public:
    explicit LiveStatePin(bool enabled=true):active(enabled){if(active){liveState();++liveStatePinDepth();}}
    ~LiveStatePin(){if(active)--liveStatePinDepth();}
    LiveStatePin(const LiveStatePin&)=delete;LiveStatePin&operator=(const LiveStatePin&)=delete;
};
inline const LivePacket *livePacket(){return liveState().controls.get();}
inline bool liveEffects(){return std::getenv("RESHADE_LIVE_EFFECTS")&&!std::getenv("RESHADE_EXPLICIT_HOST");}
int effectPlanMode() noexcept;
inline bool legacyEffectRequested(){if(liveEffects()){const auto p=livePacket();return p&&(p->flags&8);}return std::getenv("RESHADE_EFFECT")!=nullptr;}
inline bool effectRequested(){const auto mode=std::getenv("RESHADE_EFFECT_PLAN")?effectPlanMode():0;const bool requested=mode?mode==1:legacyEffectRequested();
    if(remoteIngressDiagnostics::active()){auto &d=liveControlPollDiagnosticState();d.planMode=mode;d.live=liveEffects();d.explicitHost=std::getenv("RESHADE_EXPLICIT_HOST")!=nullptr;d.requested=requested;}
    return requested;}
inline bool effectAfterScaling(){
    if(liveEffects()){const auto p=livePacket();return p&&(p->flags&32);}
    const auto value=std::getenv("RESHADE_EFFECT_PLACEMENT");return value&&!std::strcmp(value,"after");
}
struct EffectSelection {std::string file,key,revision,technique;};
inline const EffectSelection &effectSelection(){
    thread_local EffectSelection s;thread_local uint64_t applied=~uint64_t(0);thread_local bool legacy=false;
    if(liveEffects()){
        const auto &state=liveState();if(applied==state.generation)return s;applied=state.generation;s={};
        const auto p=state.controls.get();if(!p||!(p->flags&8))return s;
        s.key.assign(p->effectKey,64);s.revision.assign(p->revision,64);
        if(s.revision.find_first_not_of("0123456789abcdef")!=std::string::npos){s={};return s;}
        const auto directory=std::string(std::getenv("RESHADE_LIVE_EFFECTS"))+"/"+s.revision;
        const auto preset=directory+"/effect.slangp";
        const auto hook=directory+"/effect.hook";
        s.file=access(preset.c_str(),R_OK)==0?preset:access(hook.c_str(),R_OK)==0?hook:directory+"/effect.prepared.fx";
        if(p->flags&16)s.technique="MacLauncherChain";
    }else{
        if(legacy)return s;legacy=true;
        if(const auto v=std::getenv("RESHADE_EFFECT"))s.file=v;
        if(const auto v=std::getenv("RESHADE_EFFECT_KEY"))s.key=v;
        if(const auto v=std::getenv("RESHADE_TECHNIQUE"))s.technique=v;
        s.revision=s.file;
    }return s;
}
}

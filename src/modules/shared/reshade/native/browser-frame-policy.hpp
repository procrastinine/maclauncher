#pragma once
#include <cmath>
#include <cstdint>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
namespace macfx {
struct BrowserFrameChannelMapping {
    void *mapping=nullptr;const char *stage="disabled";int error=0;
};
// Metadata only. Call before a browser helper enters its sandbox; the retained
// mapping needs no later file access and grants no capture or GPU capability.
inline BrowserFrameChannelMapping mapBrowserFrameChannel(const char *file,const char *token)noexcept {
    if(!file||!token)return {};
    if(strlen(token)!=32)return {nullptr,"token",EINVAL};
    const auto hex=[](char c)->int{return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;};
    unsigned char expected[16];
    for(unsigned i=0;i<16;++i){const int hi=hex(token[2*i]),lo=hex(token[2*i+1]);if(hi<0||lo<0)return {nullptr,"token",EINVAL};expected[i]=unsigned((hi<<4)|lo);}
    const int fd=::open(file,O_RDWR|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return {nullptr,"open",errno};
    struct stat info{};BrowserFrameChannelMapping result;
    if(fstat(fd,&info))result={nullptr,"stat",errno};
    else if(!S_ISREG(info.st_mode)||info.st_uid!=getuid()||(info.st_mode&077)!=0||info.st_size!=64)result={nullptr,"metadata",EINVAL};
    else {
        unsigned char header[24]{};ssize_t count;do{count=pread(fd,header,sizeof(header),0);}while(count<0&&errno==EINTR);
        if(count!=sizeof(header))result={nullptr,"read",count<0?errno:EIO};
        else if(memcmp(header,"MLBRSRC1",8)||memcmp(header+8,expected,16))result={nullptr,"authentication",EACCES};
        else {void *mapped=mmap(nullptr,64,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
            result=mapped==MAP_FAILED?BrowserFrameChannelMapping{nullptr,"map",errno}:BrowserFrameChannelMapping{mapped,"mapped",0};}
    }
    close(fd);return result;
}
inline bool browserFrameFallbackReady(uint32_t selected,uint32_t observed,unsigned rejected,bool nativeFullFrame,bool registeredSourceProbe=false)noexcept {
    return selected&&selected==observed&&!nativeFullFrame&&(rejected>=3||registeredSourceProbe);
}
struct BrowserFrameDemand {uint32_t window=0,epoch=0,publisher=0;};
struct BrowserFrameAttemptContract {
    uint64_t plan=0,controls=0;
    bool operator!=(const BrowserFrameAttemptContract &other)const noexcept{return plan!=other.plan||controls!=other.controls;}
};
inline bool browserFrameRegistrationMatches(const BrowserFrameDemand &demand,uint32_t selected,uint32_t publisher,
                                            const uint32_t *contexts,unsigned count,uint32_t registered)noexcept{
    if(!demand.window||!demand.epoch||!demand.publisher||selected!=demand.window||publisher!=demand.publisher||!registered||!contexts||count>64)return false;
    for(unsigned i=0;i<count;++i)if(contexts[i]==registered)return true;return false;
}
// The authenticated 64-byte mapping keeps its original header/ownership fields.
// Its unused words carry demand, probe and epoch; no image or GPU handle does.
struct BrowserFrameChannelState {
    uint32_t *words;
    bool processingAllowed()const{return !__atomic_load_n(words+7,__ATOMIC_ACQUIRE)||__atomic_load_n(words+12,__ATOMIC_ACQUIRE)!=0;}
    bool lock(){uint32_t empty=0;return __atomic_compare_exchange_n(words+15,&empty,1,false,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED);}
    void unlock(){__atomic_store_n(words+15,0,__ATOMIC_RELEASE);}
    uint32_t window()const{const auto sequence=__atomic_load_n(words+6,__ATOMIC_SEQ_CST);if(sequence&1)return __atomic_load_n(words+12,__ATOMIC_ACQUIRE);
        const auto value=__atomic_load_n(words+8,__ATOMIC_RELAXED);
        if(sequence!=__atomic_load_n(words+6,__ATOMIC_SEQ_CST))return __atomic_load_n(words+12,__ATOMIC_ACQUIRE);
        return value==__atomic_load_n(words+12,__ATOMIC_ACQUIRE)?value:0;}
    uint32_t publish(uint32_t value){const auto previous=__atomic_load_n(words+6,__ATOMIC_RELAXED);auto next=previous+2;if(!next)next=2;
        __atomic_store_n(words+6,next-1,__ATOMIC_SEQ_CST);__atomic_store_n(words+8,value,__ATOMIC_RELAXED);__atomic_store_n(words+6,next,__ATOMIC_SEQ_CST);return next;}
    bool demand(uint32_t value,bool localWindow,uint32_t process){if(!process||!lock())return false;
        auto publisher=__atomic_load_n(words+7,__ATOMIC_RELAXED);
        if(!publisher&&localWindow){publisher=process;__atomic_store_n(words+7,publisher,__ATOMIC_RELEASE);}
        if(publisher!=process){unlock();return false;}
        if(__atomic_load_n(words+12,__ATOMIC_RELAXED)!=value){
            __atomic_store_n(words+9,value,__ATOMIC_RELAXED);__atomic_store_n(words+10,0,__ATOMIC_RELAXED);__atomic_store_n(words+13,0,__ATOMIC_RELAXED);
            auto epoch=__atomic_load_n(words+14,__ATOMIC_RELAXED)+1;if(!epoch)epoch=1;
            __atomic_store_n(words+14,epoch,__ATOMIC_RELAXED);__atomic_store_n(words+12,value,__ATOMIC_RELEASE);publish(0);
        }unlock();return true;
    }
    BrowserFrameDemand demand(){if(!lock())return {};
        BrowserFrameDemand value{__atomic_load_n(words+12,__ATOMIC_RELAXED),__atomic_load_n(words+14,__ATOMIC_RELAXED),__atomic_load_n(words+7,__ATOMIC_RELAXED)};unlock();return value;}
    void observe(uint32_t value,bool full){if(!value)return;
        if(full){
            // Native admission cannot lose its evidence to the metadata try-lock.
            // Publish the epoch before its subsequent ownership check; claim()
            // publishes ownership before checking this word. Sequential ordering
            // prevents both paths from admitting the same source concurrently.
            const auto epoch=__atomic_load_n(words+14,__ATOMIC_ACQUIRE);
            if(!epoch||__atomic_load_n(words+12,__ATOMIC_ACQUIRE)!=value||window())return;
            auto observed=__atomic_load_n(words+11,__ATOMIC_SEQ_CST);
            for(unsigned attempt=0;attempt<3&&observed!=epoch;++attempt){
                // Epoch tags also prevent a delayed older observer from erasing
                // newer evidence. No per-frame state reset is required on Off.
                if(observed&&int32_t(epoch-observed)<=0)return;
                if(__atomic_compare_exchange_n(words+11,&observed,epoch,false,__ATOMIC_SEQ_CST,__ATOMIC_SEQ_CST))return;
            }return;
        }
        if(!lock())return;
        if(__atomic_load_n(words+9,__ATOMIC_RELAXED)==value&&__atomic_load_n(words+12,__ATOMIC_RELAXED)==value&&!window()){
            const auto count=__atomic_load_n(words+10,__ATOMIC_RELAXED);if(count<3)__atomic_store_n(words+10,count+1,__ATOMIC_RELAXED);}
        unlock();}
    bool probe(uint32_t value,uint32_t epoch){if(!lock())return false;
        const bool current=value&&epoch&&__atomic_load_n(words+12,__ATOMIC_RELAXED)==value&&__atomic_load_n(words+14,__ATOMIC_RELAXED)==epoch;
        if(current)__atomic_store_n(words+13,epoch,__ATOMIC_RELAXED);unlock();return current;}
    bool eligibleLocked(uint32_t value)const{const auto epoch=__atomic_load_n(words+14,__ATOMIC_RELAXED);
        return __atomic_load_n(words+12,__ATOMIC_RELAXED)==value&&browserFrameFallbackReady(value,__atomic_load_n(words+9,__ATOMIC_RELAXED),__atomic_load_n(words+10,__ATOMIC_RELAXED),epoch&&__atomic_load_n(words+11,__ATOMIC_SEQ_CST)==epoch,epoch&&__atomic_load_n(words+13,__ATOMIC_RELAXED)==epoch);}
    bool eligible(uint32_t value){if(!lock())return false;const bool result=eligibleLocked(value);unlock();return result;}
    uint32_t claim(uint32_t value,uint32_t process){if(!lock())return 0;
        auto ticket=__atomic_load_n(words+7,__ATOMIC_RELAXED)==process&&eligibleLocked(value)&&!window()?publish(value):0;
        if(ticket&&__atomic_load_n(words+11,__ATOMIC_SEQ_CST)==__atomic_load_n(words+14,__ATOMIC_RELAXED)){publish(0);ticket=0;}
        unlock();return ticket;}
    bool owns(uint32_t value,uint32_t ticket)const{return ticket&&window()==value&&__atomic_load_n(words+6,__ATOMIC_ACQUIRE)==ticket;}
    // Owner publication is main-thread-only. A delayed old failure must not
    // release the replacement's claim, including Off->On of the same window.
    void release(uint32_t value,uint32_t ticket,uint32_t process){if(__atomic_load_n(words+7,__ATOMIC_RELAXED)==process&&owns(value,ticket))publish(0);}
};
struct BrowserFrameAdmission {
    uint32_t window=0;unsigned rejected=0;bool nativeFullFrame=false,registeredSourceProbe=false;
    void select(uint32_t value)noexcept{if(window!=value){window=value;rejected=0;nativeFullFrame=false;registeredSourceProbe=false;}}
    void observe(uint32_t value,bool full) noexcept {
        if(!value||value!=window)return;
        if(full)nativeFullFrame=true;else if(rejected<3)++rejected;
    }
    void probe(uint32_t value)noexcept{if(value&&value==window)registeredSourceProbe=true;}
    bool fallback(uint32_t value)const noexcept{return browserFrameFallbackReady(value,window,rejected,nativeFullFrame,registeredSourceProbe);}
};
// The caller converts the WindowServer mach display timestamp into seconds.
// Idle/duplicate samples never advance source cadence or interpolation history.
inline bool browserFrameTimeAccepted(double value,double previous) noexcept {
    return std::isfinite(value)&&value>0&&value>previous;
}
inline bool browserFrameCanReveal(bool ready,uint64_t generation,uint64_t completedGeneration,
                                  uint64_t gpuCompleted,uint64_t after,uint64_t acceptedGeneration,
                                  uint64_t firstAcceptedFrameId,uint64_t finalCompletedFrameId)noexcept {
    return ready&&generation==completedGeneration&&gpuCompleted>after&&generation==acceptedGeneration&&
        firstAcceptedFrameId&&finalCompletedFrameId>=firstAcceptedFrameId;
}
struct BrowserFrameGeometry {double x=0,y=0,width=0,height=0;unsigned pixelsWidth=0,pixelsHeight=0;};
inline bool browserFrameGeometryValid(const BrowserFrameGeometry &v)noexcept {
    return std::isfinite(v.x)&&std::isfinite(v.y)&&std::isfinite(v.width)&&std::isfinite(v.height)&&
        v.x>=0&&v.y>=0&&v.width>0&&v.height>0&&v.pixelsWidth>0&&v.pixelsHeight>0&&v.pixelsWidth<=16384&&v.pixelsHeight<=16384;
}
}

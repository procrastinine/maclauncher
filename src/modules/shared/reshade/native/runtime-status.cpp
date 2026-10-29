#include "runtime-status.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <libproc.h>
#include <iterator>
#include <sched.h>
#include <string>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace macfx { namespace {
using namespace runtime_status;
struct Mapping {
    pid_t pid=getpid();void* page=MAP_FAILED;std::atomic_flag writing=ATOMIC_FLAG_INIT;
    std::atomic<bool> active{false};
    uint64_t startSeconds=0,startMicroseconds=0;
    uint64_t seen[slotCount][stageCount+1][4]{};
};
std::atomic<Mapping*> mapping{nullptr};
std::atomic<uint64_t> requestConfiguration{0},requestEpoch{0},nextRequest{0};
std::atomic<bool> requestActive{false},requestPending{false};
uint64_t now() noexcept {return uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());}
bool leaseHeld(const Mapping* value) noexcept {
    if(!value||value->pid!=getpid()||value->page==MAP_FAILED)return false;
    const auto until=__atomic_load_n(&static_cast<Header*>(value->page)->leaseUntil,__ATOMIC_ACQUIRE),current=now();
    return until>=current&&until-current<=10000;
}
bool leased(const Mapping* value) noexcept {return value&&value->active.load(std::memory_order_relaxed)&&leaseHeld(value);}
// This process's mapping stops recording frames; nothing is mapped.
void deactivate() noexcept {auto* value=mapping.load(std::memory_order_acquire);if(value&&value->pid==getpid())value->active.store(false,std::memory_order_release);}
template<size_t N>void copy(char(&to)[N],std::string_view from)noexcept {
    const auto count=std::min(from.size(),N-1);if(count)std::memcpy(to,from.data(),count);std::memset(to+count,0,N-count);
}
bool text(const char* value,size_t maximum) noexcept {return value&&*value&&strnlen(value,maximum+1)<=maximum;}
bool hexadecimal(const char* value)noexcept {
    if(!text(value,64)||strlen(value)!=64)return false;
    for(unsigned i=0;i<64;++i)if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')))return false;
    return true;
}
bool hexadecimal(std::string_view value)noexcept {
    return value.size()==64&&std::all_of(value.begin(),value.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
Context* slot(Mapping* value,unsigned index)noexcept {return reinterpret_cast<Context*>(static_cast<char*>(value->page)+headerSize+index*slotSize);}
void begin(Context* row)noexcept {__atomic_add_fetch(&row->sequence,1,__ATOMIC_ACQ_REL);}
void end(Context* row)noexcept {__atomic_add_fetch(&row->sequence,1,__ATOMIC_RELEASE);}
unsigned contextIndex(Mapping* value,uintptr_t context,bool create) noexcept {
    unsigned selected=slotCount;
    for(unsigned i=0;i<slotCount;++i){auto* row=slot(value,i);
        if(__atomic_load_n(&row->pid,__ATOMIC_ACQUIRE)==uint32_t(value->pid)&&row->id==context&&
           row->processStartSeconds==value->startSeconds&&row->processStartMicroseconds==value->startMicroseconds){selected=i;break;}}
    if(selected!=slotCount||!create)return selected;
    if(selected==slotCount)for(unsigned i=0;i<slotCount;++i){auto* row=slot(value,i);uint32_t expected=0;
        if(__atomic_compare_exchange_n(&row->pid,&expected,uint32_t(value->pid),false,__ATOMIC_ACQ_REL,__ATOMIC_RELAXED)){
            begin(row);row->id=context;end(row);selected=i;break;}}
    if(selected==slotCount)for(unsigned i=0;i<slotCount;++i){auto* row=slot(value,i);
        if(row->pid==uint32_t(value->pid)&&(row->phase==uint32_t(RuntimeStatusPhase::Stopped)||
           row->processStartSeconds!=value->startSeconds||row->processStartMicroseconds!=value->startMicroseconds)){
            begin(row);row->id=context;row->phase=uint32_t(RuntimeStatusPhase::Stopped);end(row);selected=i;break;}}
    // Rows of ended producers are not always retired. A row this process has
    // not written for longer than readers keep a context current (6 s) is
    // historical to them; the oldest such row serves a live context instead
    // of dropping its observations.
    if(selected==slotCount){const auto current=now();uint64_t oldest=0;
        for(unsigned i=0;i<slotCount;++i){auto* row=slot(value,i);
            if(row->pid==uint32_t(value->pid)&&row->observedAt&&row->observedAt+6000<current&&(!oldest||row->observedAt<oldest)){oldest=row->observedAt;selected=i;}}
        if(selected!=slotCount){auto* row=slot(value,selected);begin(row);row->id=context;row->phase=uint32_t(RuntimeStatusPhase::Stopped);end(row);}}
    return selected;
}
}
void pollRuntimeStatus(bool processingRequested) noexcept {
    // Without processing, an existing mapping stops recording frames, and a
    // process that has none still maps a leased page at the same bounded rate
    // without recording frames, so its pass-through acknowledgments (an Off
    // launch, or an edit that keeps Off) reach the reader.
    auto* value=mapping.load(std::memory_order_acquire);
    if(value&&value->pid==getpid()&&value->page!=MAP_FAILED){value->active.store(processingRequested,std::memory_order_release);return;}
    static std::atomic<uint64_t> polling{0};const auto owner=uint64_t(uint32_t(getpid()))<<1;
    auto previous=polling.load(std::memory_order_relaxed);
    if((previous>>1)==(owner>>1)&&(previous&1))return;
    if(!polling.compare_exchange_strong(previous,owner|1,std::memory_order_acquire))return;
    struct Unlock{std::atomic<uint64_t>&state;uint64_t value;~Unlock(){state.store(value,std::memory_order_release);}}unlock{polling,owner};
    // The control tick is already bounded. Missing consumers do not introduce
    // another timer, watcher or thread, or attempt an open on each frame.
    static pid_t lastPid=0;static std::chrono::steady_clock::time_point next;
    const auto current=std::chrono::steady_clock::now();
    if(lastPid==getpid()&&current<next)return;
    lastPid=getpid();next=current+std::chrono::seconds(1);
    const char* file=getenv("RESHADE_RUNTIME_STATUS_FILE"),*token=getenv("RESHADE_RUNTIME_STATUS_TOKEN"),*launch=getenv("RESHADE_RUNTIME_STATUS_LAUNCH_ID");
    if(!file||*file!='/'||!hexadecimal(token)||!text(launch,127))return;
    struct stat named{};
    if(lstat(file,&named)||!S_ISREG(named.st_mode)||named.st_uid!=getuid()||named.st_size!=off_t(pageSize))return;
    const int fd=open(file,O_RDWR|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return;
    const auto owns=[&]{struct stat current{};const int flags=fcntl(fd,F_GETFD);return flags>=0&&(flags&FD_CLOEXEC)&&!fstat(fd,&current)&&
        S_ISREG(current.st_mode)&&current.st_dev==named.st_dev&&current.st_ino==named.st_ino&&current.st_uid==named.st_uid;};
    const auto closeOwned=[&]{if(owns())close(fd);};
    struct stat info{};
    if(!owns()||fstat(fd,&info)||info.st_size!=off_t(pageSize)){closeOwned();return;}
    void* page=mmap(nullptr,pageSize,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);closeOwned();if(page==MAP_FAILED)return;
    const auto* header=static_cast<const Header*>(page);
    const auto lease=__atomic_load_n(&header->leaseUntil,__ATOMIC_ACQUIRE),time=now();
    if(std::memcmp(header->magic,"MLFXSTS1",8)||header->version!=schema||header->bytes!=pageSize||header->launchIdLength!=strlen(launch)||
       std::memcmp(header->token,token,64)||std::memcmp(header->launchId,launch,strlen(launch))||lease<time||lease-time>10000){munmap(page,pageSize);return;}
    try {
        auto* prepared=new Mapping;prepared->page=page;prepared->active=processingRequested;
        proc_bsdinfo process{};
        if(proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&process,sizeof(process))==sizeof(process)){
            prepared->startSeconds=process.pbi_start_tvsec;prepared->startMicroseconds=process.pbi_start_tvusec;
        }
        mapping.store(prepared,std::memory_order_release);
    }catch(...){munmap(page,pageSize);}
}
void requestRuntimeStatusPoll(bool processingRequested) noexcept {
    if(!processingRequested){if(requestActive.exchange(false,std::memory_order_acq_rel))requestEpoch.fetch_add(1,std::memory_order_acq_rel);deactivate();return;}
    const auto pid=uint32_t(getpid());auto* value=mapping.load(std::memory_order_acquire);
    requestActive.store(true,std::memory_order_release);
    if(value&&value->pid==getpid()&&value->page!=MAP_FAILED){value->active.store(true,std::memory_order_release);return;}
    auto configured=requestConfiguration.load(std::memory_order_acquire);
    if((configured>>2)!=pid){
        const auto initial=(uint64_t(pid)<<2)|3;
        if(!requestConfiguration.compare_exchange_strong(configured,initial,std::memory_order_acq_rel))return;
        requestPending=false;nextRequest=0;requestEpoch.fetch_add(1,std::memory_order_acq_rel);
        const char* file=getenv("RESHADE_RUNTIME_STATUS_FILE"),*token=getenv("RESHADE_RUNTIME_STATUS_TOKEN"),*launch=getenv("RESHADE_RUNTIME_STATUS_LAUNCH_ID");
        const bool valid=file&&*file=='/'&&hexadecimal(token)&&text(launch,127);
        configured=(uint64_t(pid)<<2)|(valid?1:2);requestConfiguration.store(configured,std::memory_order_release);
    }
    if((configured&3)!=1)return;
    const auto clock=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
    if(clock<nextRequest.load(std::memory_order_relaxed)||requestPending.exchange(true,std::memory_order_acq_rel))return;
    nextRequest.store(clock+1000,std::memory_order_release);
    const auto ticket=(uint64_t(pid)<<32)|uint32_t(requestEpoch.load(std::memory_order_acquire));
    dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),reinterpret_cast<void*>(uintptr_t(ticket)),[](void* opaque){
        const auto ticket=uint64_t(reinterpret_cast<uintptr_t>(opaque));
        if((ticket>>32)!=uint32_t(getpid()))return;
        const auto current=[&]{return requestActive.load(std::memory_order_acquire)&&uint32_t(requestEpoch.load(std::memory_order_acquire))==uint32_t(ticket);};
        if(current())pollRuntimeStatus(true);
        if(!current())deactivate();
        requestPending.store(false,std::memory_order_release);
    });
}
void observeRuntimeStatus(const RuntimeStatusEvent& event) noexcept {
    if(!event.processing||!event.context)return;
    if(event.phase==RuntimeStatusPhase::Presented&&(!std::isfinite(event.presentedTime)||event.presentedTime<=0))return;
    // Native renderer loops can process frames without running AppKit timers.
    // Actual work arms the same bounded asynchronous metadata request; an
    // existing mapping needs only atomic activation on this path.
    if(!event.idle&&!event.asynchronous&&(event.phase==RuntimeStatusPhase::Encoded||event.phase==RuntimeStatusPhase::Prepared&&event.resourceAccepted))requestRuntimeStatusPoll(true);
    auto* value=mapping.load(std::memory_order_acquire);
    if(!(event.idle?leaseHeld(value):leased(value))||value->writing.test_and_set(std::memory_order_acquire))return;
    const unsigned selected=contextIndex(value,event.context,true);
    if(selected!=slotCount){
        auto* row=slot(value,selected);
        const bool delayed=event.asynchronous||event.phase==RuntimeStatusPhase::Completed||event.phase==RuntimeStatusPhase::Presented;
        if(delayed&&row->acceptedRevision[0]&&
           ((!event.planRevision.empty()&&event.planRevision!=std::string_view(row->acceptedRevision,strnlen(row->acceptedRevision,sizeof(row->acceptedRevision))))||
            (!event.controlsDigest.empty()&&row->acceptedControlsDigest[0]&&event.controlsDigest!=std::string_view(row->acceptedControlsDigest,strnlen(row->acceptedControlsDigest,sizeof(row->acceptedControlsDigest)))))){
            value->writing.clear(std::memory_order_release);return;
        }
        begin(row);
        if(row->phase==uint32_t(RuntimeStatusPhase::Stopped)||
           (!event.planRevision.empty()&&event.planRevision!=std::string_view(row->planRevision,strnlen(row->planRevision,sizeof(row->planRevision))))||
           (!event.controlsDigest.empty()&&event.controlsDigest!=std::string_view(row->controlsDigest,strnlen(row->controlsDigest,sizeof(row->controlsDigest))))){
            // A candidate can report Prepared/Failed without being adopted.
            // Preserve accepted resources through those attempted revisions.
            char accepted[144]{};const Admission admission=row->admission;const FrameSource frameSource=row->frameSource;const bool retain=row->phase!=uint32_t(RuntimeStatusPhase::Stopped);
            if(retain)std::memcpy(accepted,row->acceptedRevision,sizeof(accepted));
            std::memset(reinterpret_cast<char*>(row)+16,0,sizeof(Context)-16);std::memset(value->seen[selected],0,sizeof(value->seen[selected]));
            if(retain){std::memcpy(row->acceptedRevision,accepted,sizeof(accepted));row->admission=admission;row->frameSource=frameSource;}
        }
        if(!event.planRevision.empty())copy(row->planRevision,event.planRevision);
        if(!event.controlsDigest.empty())copy(row->controlsDigest,event.controlsDigest);
        row->processStartSeconds=value->startSeconds;row->processStartMicroseconds=value->startMicroseconds;
        row->observedAt=now();
        if(event.resourceAccepted&&event.stageId.empty()&&hexadecimal(event.planRevision)&&
           (event.controlsDigest.empty()||hexadecimal(event.controlsDigest))){
            copy(row->acceptedRevision,event.planRevision);copy(row->acceptedControlsDigest,event.controlsDigest);row->acceptedAt=row->observedAt;
        }
        if(row->stages>stageCount)row->stages=0;
        unsigned index=stageCount;
        if(!event.stageId.empty()){
            for(unsigned i=0;i<row->stages;++i)if(event.stageId==std::string_view(row->rows[i].id,strnlen(row->rows[i].id,sizeof(row->rows[i].id)))){index=i;break;}
            if(index==stageCount&&row->stages<stageCount){index=row->stages++;copy(row->rows[index].id,event.stageId);}
        }
        if(event.stageId.empty()){
            row->phase=uint32_t(event.phase);row->frameId=event.frameId;
            if(std::isfinite(event.sourceTime))row->sourceTime=event.sourceTime;
            if(event.phase==RuntimeStatusPhase::Presented&&std::isfinite(event.presentedTime)&&event.presentedTime>0)row->presentedTime=event.presentedTime;
            if(event.inputWidth&&event.inputHeight){row->inputWidth=event.inputWidth;row->inputHeight=event.inputHeight;}
            if(event.outputWidth&&event.outputHeight){row->outputWidth=event.outputWidth;row->outputHeight=event.outputHeight;}
            if(event.requestedBytes||event.admittedBytes){row->requestedBytes=event.requestedBytes;row->admittedBytes=event.admittedBytes;}
            if(!event.planRevision.empty())copy(row->planRevision,event.planRevision);
            if(!event.controlsDigest.empty())copy(row->controlsDigest,event.controlsDigest);
            copy(row->reason,event.reason);
        }else if(index<stageCount){auto& stage=row->rows[index];stage.phase=uint32_t(event.phase);stage.frameId=event.frameId;
            stage.observedAt=row->observedAt;
            if(event.inputWidth&&event.inputHeight){stage.inputWidth=event.inputWidth;stage.inputHeight=event.inputHeight;}
            if(event.outputWidth&&event.outputHeight){stage.outputWidth=event.outputWidth;stage.outputHeight=event.outputHeight;}
            if(!event.requestedMethod.empty())copy(stage.requested,event.requestedMethod);
            if(!event.activeMethod.empty())copy(stage.active,event.activeMethod);copy(stage.reason,event.reason);}
        const int counter=event.phase==RuntimeStatusPhase::Encoded?0:event.phase==RuntimeStatusPhase::Completed?1:event.phase==RuntimeStatusPhase::Presented?(event.generated?3:2):-1;
        auto& seen=value->seen[selected][event.stageId.empty()?stageCount:index<stageCount?index:stageCount];
        uint64_t observation=event.frameId;if(counter>=2)std::memcpy(&observation,&event.presentedTime,sizeof(observation));
        if(counter>=0&&event.frameId&&(event.stageId.empty()||index<stageCount)&&seen[counter]!=observation){seen[counter]=observation;
            if(event.stageId.empty()){if(counter==0)++row->encoded;else if(counter==1)++row->completed;else if(event.generated)++row->presentedGenerated;else ++row->presentedReal;}
            else if(index<stageCount){auto& stage=row->rows[index];if(counter==0)++stage.encoded;else if(counter==1)++stage.completed;else ++stage.presented;}}
        end(row);
    }
    value->writing.clear(std::memory_order_release);
}
bool runtimeStatusLeased() noexcept {return leaseHeld(mapping.load(std::memory_order_acquire));}
void observeRuntimeFrameSource(uintptr_t context,RuntimeFrameSource source,uint32_t inputs) noexcept {
    if(!context||source==RuntimeFrameSource::Unknown)return;
    auto* value=mapping.load(std::memory_order_acquire);if(!leased(value)||value->writing.test_and_set(std::memory_order_acquire))return;
    const unsigned selected=contextIndex(value,context,false);
    if(selected!=slotCount){auto* row=slot(value,selected);begin(row);row->frameSource={};row->frameSource.schema=1;row->frameSource.source=uint32_t(source);row->frameSource.inputs=inputs;row->frameSource.observedAt=now();end(row);}
    value->writing.clear(std::memory_order_release);
}
void observeRuntimeAdaptiveQuality(const RuntimeAdaptiveQualityEvent&event) noexcept {
    const auto state=uint32_t(event.state),scope=uint32_t(event.scope);
    if(!event.context||!hexadecimal(event.planRevision)||state<1||state>3||scope>5||
       (event.state==RuntimeAdaptiveQualityState::Active&&scope==0)||event.nodeId.empty()||event.nodeId.size()>128||
       !std::isfinite(event.scale)||event.scale<=0||event.scale>16||!std::isfinite(event.meanMilliseconds)||event.meanMilliseconds<0||
       (!event.controlsDigest.empty()&&!hexadecimal(event.controlsDigest)))return;
    auto*value=mapping.load(std::memory_order_acquire);
    if(!leased(value)||value->writing.test_and_set(std::memory_order_acquire))return;
    const unsigned selected=contextIndex(value,event.context,false);
    if(selected!=slotCount){
        auto*row=slot(value,selected);
        const char*revision=row->acceptedRevision[0]?row->acceptedRevision:row->planRevision;
        const char*controls=row->acceptedControlsDigest[0]?row->acceptedControlsDigest:row->controlsDigest;
        if(row->phase!=uint32_t(RuntimeStatusPhase::Stopped)&&event.planRevision==std::string_view(revision,strnlen(revision,65))&&
           (event.controlsDigest.empty()||event.controlsDigest==std::string_view(controls,strnlen(controls,65)))){
            begin(row);auto&quality=row->adaptiveQuality;quality={};quality.schema=1;quality.state=state;quality.scope=scope;
            quality.scale=event.scale;quality.meanMilliseconds=event.meanMilliseconds;quality.observedAt=now();
            copy(quality.nodeId,event.nodeId);copy(quality.reason,event.reason);end(row);
        }
    }
    value->writing.clear(std::memory_order_release);
}
void observeRuntimeAdmission(uintptr_t context,std::string_view reason,unsigned width,unsigned height,uintptr_t queue,uint32_t format) noexcept {
    if(!context)return;auto* value=mapping.load(std::memory_order_acquire);if(!leased(value))return;
    static constexpr const char* reasons[]={"frame-owner-accepted","frame-owner-missing","present-registered","present-already-claimed","present-commit",
        "frame-resource-busy","frame-processor-busy","frame-image-budget","runtime-device-changed","runtime-queue-changed","runtime-size-changed",
        "runtime-format-changed","runtime-placement-changed","runtime-selection-changed","owner-published-new","owner-published-unchanged","owner-unselected",
        "owner-retired","history-replayed","history-original","framebuffer-resource-busy","framebuffer-image-budget","history-empty"};
    unsigned decision=0;while(decision<std::size(reasons)&&reason!=reasons[decision])++decision;if(decision==std::size(reasons))return;
    if(value->writing.test_and_set(std::memory_order_acquire))return;
    const bool create=reason=="frame-owner-accepted"||reason=="present-registered"||reason=="owner-published-new";
    const unsigned index=contextIndex(value,context,create);
    if(index!=slotCount){auto* row=slot(value,index);begin(row);
        if(row->phase==uint32_t(RuntimeStatusPhase::Stopped)){std::memset(reinterpret_cast<char*>(row)+16,0,sizeof(Context)-16);std::memset(value->seen[index],0,sizeof(value->seen[index]));}
        row->processStartSeconds=value->startSeconds;row->processStartMicroseconds=value->startMicroseconds;
        // Admission describes the source's frames, not a frame this context
        // processed. It keeps an admission-only row current, never a row with
        // a frame phase or an accepted revision: when another context (its
        // presentation) reports the source's frames, this row leaves the vote.
        auto& admission=row->admission;admission.schema=1;admission.reason=decision;admission.observedAt=now();++admission.counts[decision];
        if(!row->phase&&!row->acceptedRevision[0])row->observedAt=admission.observedAt;
        if(reason=="owner-published-new"||reason=="owner-retired")++admission.generation;
        if(queue)admission.queue=queue;if(format)admission.format=format;if(width&&height){admission.width=width;admission.height=height;}
        end(row);
    }
    value->writing.clear(std::memory_order_release);
}
// A context that ended never reads as current: its row is marked Stopped
// whenever this process has the page mapped, also Off or between leases.
// Retirement is rare, so a concurrent writer is waited out briefly.
void retireRuntimeStatus(uintptr_t context) noexcept {
    auto* value=mapping.load(std::memory_order_acquire);
    if(!context||!value||value->pid!=getpid()||value->page==MAP_FAILED)return;
    for(unsigned attempt=0;value->writing.test_and_set(std::memory_order_acquire);++attempt){if(attempt==64)return;sched_yield();}
    for(unsigned i=0;i<slotCount;++i){auto* row=slot(value,i);if(row->pid==uint32_t(value->pid)&&row->id==context){begin(row);row->phase=uint32_t(RuntimeStatusPhase::Stopped);row->adaptiveQuality={};end(row);break;}}
    value->writing.clear(std::memory_order_release);
}
}

#include "runtime-status.hpp"
#include <cassert>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <new>
#include <chrono>
#include <cstdio>
#include <sys/mman.h>
#include <unistd.h>

static std::atomic<size_t> allocations{0};
void* operator new(std::size_t size){++allocations;if(auto* result=std::malloc(size))return result;throw std::bad_alloc();}
void operator delete(void* value)noexcept{std::free(value);}
void operator delete(void* value,std::size_t)noexcept{std::free(value);}
int main(int argc,char** argv){
    using namespace macfx;using namespace macfx::runtime_status;
    char directory[1024]{},ownedFile[1100]{},revision[65]{},digest[65]{};
    const bool standalone=argc==1;
    if(standalone){
        // Sandboxed hosts may deny /tmp; prefer the per-user temporary directory.
        const char* temporary=std::getenv("TMPDIR");if(!temporary||!*temporary)temporary="/tmp";
        const bool separator=temporary[std::strlen(temporary)-1]!='/';
        assert(snprintf(directory,sizeof(directory),"%s%smacfx-runtime-status-XXXXXX",temporary,separator?"/":"")<int(sizeof(directory)));
        assert(mkdtemp(directory));snprintf(ownedFile,sizeof(ownedFile),"%s/status.bin",directory);
        int output=open(ownedFile,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);assert(output>=0&&ftruncate(output,pageSize)==0);
        Header header{};std::memcpy(header.magic,"MLFXSTS1",8);header.version=schema;header.bytes=pageSize;
        header.leaseUntil=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())+6000;
        std::memset(header.token,'a',64);std::memcpy(header.launchId,"cpu",3);header.launchIdLength=3;
        assert(pwrite(output,&header,sizeof(header),0)==sizeof(header));close(output);
        std::memset(revision,'a',64);std::memset(digest,'b',64);char token[65]{};std::memset(token,'a',64);
        setenv("RESHADE_RUNTIME_STATUS_FILE",ownedFile,1);setenv("RESHADE_RUNTIME_STATUS_TOKEN",token,1);setenv("RESHADE_RUNTIME_STATUS_LAUNCH_ID","cpu",1);
    }else assert(argc==3||argc==4);
    const char* file=getenv("RESHADE_RUNTIME_STATUS_FILE");assert(file);
    int fd=open(file,O_RDWR|O_CLOEXEC|O_NOFOLLOW);assert(fd>=0);
    auto* page=static_cast<char*>(mmap(nullptr,pageSize,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0));close(fd);assert(page!=MAP_FAILED);
    auto* row=reinterpret_cast<Context*>(page+headerSize);
    RuntimeStatusEvent event{};event.context=123;event.planRevision=standalone?revision:argv[1];event.controlsDigest=standalone?digest:argv[2];
    event.inputWidth=8;event.inputHeight=8;event.outputWidth=16;event.outputHeight=16;event.frameId=42;event.sourceTime=2;
    requestRuntimeStatusPoll(false);event.processing=true;observeRuntimeStatus(event);
    observeRuntimeAdmission(event.context,"frame-owner-accepted",8,8);assert(row->pid==0);
    event.processing=false;observeRuntimeStatus(event);assert(row->pid==0);
    // Pass-through adoption never maps a page or requests a poll.
    event.processing=true;event.idle=true;observeRuntimeStatus(event);event.idle=false;event.processing=false;assert(row->pid==0&&!runtimeStatusLeased());
    if(standalone){
        // Off: the control poll maps a leased page without recording frames,
        // so a process that never processed acknowledges pass-through (D11).
        pollRuntimeStatus(false);assert(runtimeStatusLeased()&&row->pid==0);
        event.processing=true;observeRuntimeStatus(event);
        observeRuntimeFrameSource(event.context,RuntimeFrameSource::ExplicitTexture,RuntimeInputDepth);assert(row->pid==0);
        event.idle=true;event.resourceAccepted=true;event.phase=RuntimeStatusPhase::Bypassed;observeRuntimeStatus(event);
        assert(row->pid==uint32_t(getpid())&&row->phase==uint32_t(RuntimeStatusPhase::Bypassed)&&std::strcmp(row->acceptedRevision,revision)==0);
        event.idle=false;event.resourceAccepted=false;event.phase=RuntimeStatusPhase::Prepared;event.processing=false;std::memset(static_cast<void*>(row),0,slotSize);
        // A cold preparation worker maps an existing lease before the first
        // real frame. Mapping alone cannot manufacture a context or counters.
        pollRuntimeStatus(true);assert(row->pid==0);
        event.processing=true;observeRuntimeStatus(event);
        observeRuntimeFrameSource(event.context,RuntimeFrameSource::ExplicitTexture,RuntimeInputDepth);
        assert(row->phase==uint32_t(RuntimeStatusPhase::Prepared)&&row->encoded==0&&row->completed==0);
        assert(row->frameSource.schema==1&&row->frameSource.source==uint32_t(RuntimeFrameSource::ExplicitTexture));
    }
    requestRuntimeStatusPoll(true);event.processing=true;
    for(unsigned attempt=0;attempt<1000&&!row->pid;++attempt){observeRuntimeStatus(event);if(!row->pid)usleep(1000);}
    assert(row->pid==uint32_t(getpid()));const auto before=allocations.load();
    observeRuntimeStatus(event);assert(row->pid==uint32_t(getpid())&&row->phase==1&&row->completed==0&&row->presentedReal==0);
    observeRuntimeAdmission(event.context,"frame-owner-accepted",8,8,0x100,80);
    for(unsigned i=0;i<32;++i)observeRuntimeAdmission(event.context,"frame-owner-missing",8,8);
    observeRuntimeAdmission(event.context,"owner-published-new",8,8);
    assert(row->admission.schema==1&&row->admission.counts[0]==1&&row->admission.counts[1]==32&&row->admission.generation==1);
    assert(row->admission.queue==0x100&&row->admission.format==80&&row->encoded==0&&row->completed==0&&row->presentedReal==0&&row->acceptedRevision[0]==0);
    if(argc==4){
        assert(std::strcmp(argv[3],"--acceptance")==0&&row->acceptedRevision[0]==0);
        const auto original=event.planRevision;char candidate[65]{};std::memset(candidate,'c',64);
        event.planRevision=candidate;event.stageId="candidate";observeRuntimeStatus(event);
        event.stageId={};event.phase=RuntimeStatusPhase::Failed;observeRuntimeStatus(event);
        assert(row->acceptedRevision[0]==0);
        event.planRevision=original;event.phase=RuntimeStatusPhase::Prepared;event.resourceAccepted=true;observeRuntimeStatus(event);
        assert(std::strcmp(row->acceptedRevision,argv[1])==0&&row->acceptedAt>0&&row->completed==0&&row->presentedReal==0);
        event.resourceAccepted=false;event.planRevision=candidate;event.stageId="candidate";observeRuntimeStatus(event);
        event.stageId={};event.phase=RuntimeStatusPhase::Failed;observeRuntimeStatus(event);
        assert(std::strcmp(row->planRevision,candidate)==0&&std::strcmp(row->acceptedRevision,argv[1])==0);
        assert(row->admission.counts[1]==32);
        event.phase=RuntimeStatusPhase::Prepared;event.resourceAccepted=true;observeRuntimeStatus(event);
        assert(std::strcmp(row->acceptedRevision,candidate)==0);
        event.planRevision=original;event.resourceAccepted=false;event.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(event);
        assert(std::strcmp(row->acceptedRevision,candidate)==0&&std::strcmp(row->planRevision,candidate)==0&&row->completed==0);
        event.phase=RuntimeStatusPhase::Failed;event.asynchronous=true;event.reason="Retired buffer failed";observeRuntimeStatus(event);
        assert(std::strcmp(row->acceptedRevision,candidate)==0&&std::strcmp(row->planRevision,candidate)==0&&row->reason[0]==0);
        event.asynchronous=false;event.reason={};
        observeRuntimeFrameSource(event.context,RuntimeFrameSource::OpenGLFramebuffer,RuntimeInputDepth);
        assert(row->frameSource.schema==1&&row->frameSource.source==2&&row->frameSource.inputs==RuntimeInputDepth);
        retireRuntimeStatus(event.context);event.phase=RuntimeStatusPhase::Prepared;observeRuntimeStatus(event);
        assert(row->acceptedRevision[0]==0&&row->completed==0);
        event.resourceAccepted=true;observeRuntimeStatus(event);event.resourceAccepted=false;
        event.planRevision=candidate;event.phase=RuntimeStatusPhase::Failed;observeRuntimeStatus(event);
        assert(std::strcmp(row->acceptedRevision,argv[1])==0&&row->completed==0&&row->presentedReal==0);
        assert(allocations.load()==before);munmap(page,pageSize);return 0;
    }
    event.stageId="tone";event.requestedMethod="crt";event.activeMethod="crt";event.phase=RuntimeStatusPhase::Encoded;
    observeRuntimeStatus(event);observeRuntimeStatus(event);assert(row->rows[0].encoded==1);
    event.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(event);assert(row->rows[0].completed==1);
    event.stageId="generation";event.requestedMethod="lsfg";event.activeMethod="passthrough";
    event.phase=RuntimeStatusPhase::Bypassed;event.reason="Selected model unavailable";observeRuntimeStatus(event);
    assert(std::strcmp(row->rows[1].active,"passthrough")==0&&row->rows[1].completed==0);
    event.stageId={};event.reason={};event.phase=RuntimeStatusPhase::Encoded;observeRuntimeStatus(event);
    event.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(event);
    event.phase=RuntimeStatusPhase::Presented;observeRuntimeStatus(event);assert(row->presentedReal==0);
    event.presentedTime=3;observeRuntimeStatus(event);event.generated=true;observeRuntimeStatus(event);
    event.presentedTime=4;observeRuntimeStatus(event);observeRuntimeStatus(event);
    assert(row->encoded==1&&row->completed==1&&row->presentedReal==1&&row->presentedGenerated==2&&row->sequence%2==0);
    assert(row->inputWidth==8&&row->outputWidth==16&&row->observedAt>0);
    observeRuntimeFrameSource(event.context,RuntimeFrameSource::OpenGLFramebuffer,RuntimeInputDepth);
    assert(row->frameSource.source==2&&row->frameSource.inputs==RuntimeInputDepth);
    char first[129]{},second[129]{};std::memset(first,'x',128);std::memset(second,'x',128);second[127]='y';
    event.phase=RuntimeStatusPhase::Encoded;event.stageId=first;observeRuntimeStatus(event);event.stageId=second;observeRuntimeStatus(event);
    assert(row->stages==4&&std::strcmp(row->rows[2].id,first)==0&&std::strcmp(row->rows[3].id,second)==0);
    const auto sequence=row->sequence;auto* header=reinterpret_cast<Header*>(page);
    const auto lease=header->leaseUntil;__atomic_store_n(&header->leaseUntil,uint64_t(0),__ATOMIC_RELEASE);
    observeRuntimeStatus(event);assert(row->sequence==sequence);
    observeRuntimeAdmission(event.context,"frame-owner-missing");assert(row->sequence==sequence&&row->admission.counts[1]==32);
    __atomic_store_n(&header->leaseUntil,lease,__ATOMIC_RELEASE);
    requestRuntimeStatusPoll(false);event.processing=false;observeRuntimeStatus(event);assert(row->sequence==sequence);
    event.processing=true;event.asynchronous=true;event.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(event);assert(row->sequence==sequence);
    event.asynchronous=false;event.phase=RuntimeStatusPhase::Presented;event.presentedTime=5;observeRuntimeStatus(event);assert(row->sequence==sequence);
    if(standalone){
        // A pass-through plan is adopted without processing demand, only while a
        // reader leases this existing mapping.
        assert(runtimeStatusLeased());char bypass[65]{};std::memset(bypass,'d',64);
        event.asynchronous=false;event.idle=true;event.resourceAccepted=true;event.phase=RuntimeStatusPhase::Bypassed;event.planRevision=bypass;event.stageId={};
        observeRuntimeStatus(event);assert(std::strcmp(row->acceptedRevision,bypass)==0&&std::strcmp(row->planRevision,bypass)==0);
        assert(row->phase==uint32_t(RuntimeStatusPhase::Bypassed)&&row->stages==0&&row->acceptedAt>0&&row->encoded==0);
        __atomic_store_n(&header->leaseUntil,uint64_t(0),__ATOMIC_RELEASE);assert(!runtimeStatusLeased());
        const auto idle=row->sequence;event.planRevision=revision;observeRuntimeStatus(event);assert(row->sequence==idle&&std::strcmp(row->acceptedRevision,bypass)==0);
        __atomic_store_n(&header->leaseUntil,lease,__ATOMIC_RELEASE);
        // Admission metadata keeps an admission-only row current, never a row
        // holding an accepted revision whose frames another context now
        // reports, such as the source layer under its presentation (D6).
        requestRuntimeStatusPoll(true);const auto latest=row->observedAt,earlier=latest-10000;row->observedAt=earlier;
        observeRuntimeAdmission(event.context,"present-commit");assert(row->observedAt==earlier&&row->admission.counts[4]==1&&row->admission.observedAt>earlier);
        row->observedAt=latest;
        const auto slotAt=[&](unsigned index){return reinterpret_cast<Context*>(page+headerSize+size_t(index)*slotSize);};
        const auto find=[&](uintptr_t context)->Context*{for(unsigned i=0;i<slotCount;++i)if(slotAt(i)->id==context&&slotAt(i)->pid==uint32_t(getpid()))return slotAt(i);return nullptr;};
        observeRuntimeAdmission(456,"frame-owner-accepted");auto* admitted=find(456);assert(admitted&&!admitted->phase&&admitted->observedAt>0);
        admitted->observedAt-=10000;const auto admittedAt=admitted->observedAt;observeRuntimeAdmission(456,"present-commit");assert(admitted->observedAt>admittedAt);
        // Live rows fill every slot. A new context reuses only the oldest row
        // that readers already treat as historical; current rows stay.
        RuntimeStatusEvent other{};other.processing=true;other.phase=RuntimeStatusPhase::Prepared;other.planRevision=revision;
        for(uintptr_t context=1000;context<1008;++context){other.context=context;observeRuntimeStatus(other);}
        for(unsigned i=0;i<slotCount;++i)assert(slotAt(i)->pid==uint32_t(getpid())&&slotAt(i)->phase!=uint32_t(RuntimeStatusPhase::Stopped));
        other.context=2000;observeRuntimeStatus(other);assert(!find(2000));
        auto* ended=find(1001);assert(ended);ended->observedAt-=7000;auto* older=find(1002);assert(older);older->observedAt-=8000;
        observeRuntimeStatus(other);auto* reused=find(2000);assert(reused==older&&find(1001)==ended&&reused->phase==uint32_t(RuntimeStatusPhase::Prepared)&&!find(1002));
        // Master Off, On, an edit, then Off again (D6). Off is acknowledged by
        // the source layer and its presentation. With processing on, the
        // presentation reports the frames under its own context and its first
        // processed frame of each revision is accepted; per-frame admission
        // still reaches the layer without keeping its Off acceptance current.
        for(unsigned i=0;i<slotCount;++i)slotAt(i)->observedAt-=7000+i;
        char off[65]{},on[65]{},edit[65]{},again[65]{};std::memset(off,'e',64);std::memset(on,'f',64);std::memset(edit,'1',64);std::memset(again,'2',64);
        RuntimeStatusEvent ack{};ack.processing=true;ack.idle=true;ack.resourceAccepted=true;ack.phase=RuntimeStatusPhase::Bypassed;ack.planRevision=off;ack.controlsDigest=digest;
        ack.context=3000;observeRuntimeStatus(ack);ack.context=3001;observeRuntimeStatus(ack);
        auto* layer=find(3000);auto* presentation=find(3001);
        assert(layer&&presentation&&layer!=presentation&&std::strcmp(layer->acceptedRevision,off)==0&&std::strcmp(presentation->acceptedRevision,off)==0);
        layer->observedAt-=1000;const auto acknowledged=layer->observedAt;presentation->acceptedAt-=1000;const auto offAccepted=presentation->acceptedAt;
        RuntimeStatusEvent frame{};frame.processing=true;frame.context=3001;frame.controlsDigest=digest;
        const auto draw=[&](const char* plan,uint64_t id){
            frame.planRevision=plan;frame.frameId=id;frame.resourceAccepted=true;frame.phase=RuntimeStatusPhase::Prepared;observeRuntimeStatus(frame);frame.resourceAccepted=false;
            frame.phase=RuntimeStatusPhase::Encoded;observeRuntimeStatus(frame);
            frame.asynchronous=true;frame.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(frame);frame.asynchronous=false;
            frame.phase=RuntimeStatusPhase::Presented;frame.presentedTime=double(id);observeRuntimeStatus(frame);
            observeRuntimeAdmission(3000,"present-commit");observeRuntimeAdmission(3000,"frame-owner-accepted");};
        draw(on,10);
        assert(std::strcmp(presentation->acceptedRevision,on)==0&&presentation->acceptedAt>offAccepted&&presentation->acceptedAt<=presentation->observedAt);
        assert(presentation->phase==uint32_t(RuntimeStatusPhase::Presented)&&presentation->encoded==1&&presentation->completed==1&&presentation->presentedReal==1);
        assert(layer->observedAt==acknowledged&&std::strcmp(layer->acceptedRevision,off)==0&&layer->phase==uint32_t(RuntimeStatusPhase::Bypassed));
        // The edit is accepted with its first frame; a late completion of the
        // earlier revision does not count toward it.
        const auto onAccepted=presentation->acceptedAt;presentation->acceptedAt-=1000;
        draw(edit,11);frame.planRevision=on;frame.asynchronous=true;frame.phase=RuntimeStatusPhase::Completed;observeRuntimeStatus(frame);frame.asynchronous=false;
        assert(std::strcmp(presentation->acceptedRevision,edit)==0&&presentation->acceptedAt>onAccepted-1000&&presentation->completed==1&&presentation->presentedReal==1);
        assert(layer->observedAt==acknowledged&&std::strcmp(layer->acceptedRevision,off)==0);
        // Off again: both contexts acknowledge the new pass-through revision.
        ack.planRevision=again;ack.context=3000;observeRuntimeStatus(ack);ack.context=3001;observeRuntimeStatus(ack);
        assert(std::strcmp(layer->acceptedRevision,again)==0&&std::strcmp(presentation->acceptedRevision,again)==0&&layer->observedAt>acknowledged);
        assert(presentation->phase==uint32_t(RuntimeStatusPhase::Bypassed)&&presentation->encoded==0);
        // A retired context reads as stopped also Off and between leases, so a
        // later reader never counts a context that ended.
        requestRuntimeStatusPoll(false);__atomic_store_n(&header->leaseUntil,uint64_t(0),__ATOMIC_RELEASE);
        retireRuntimeStatus(3000);assert(layer->phase==uint32_t(RuntimeStatusPhase::Stopped)&&std::strcmp(layer->acceptedRevision,again)==0);
        __atomic_store_n(&header->leaseUntil,lease,__ATOMIC_RELEASE);
    }
    assert(allocations.load()==before);
    munmap(page,pageSize);
    if(standalone){assert(unlink(ownedFile)==0);assert(rmdir(directory)==0);}
}

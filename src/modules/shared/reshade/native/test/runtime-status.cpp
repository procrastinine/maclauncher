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
    char directory[]="/tmp/macfx-runtime-status-XXXXXX",ownedFile[256]{},revision[65]{},digest[65]{};
    const bool standalone=argc==1;
    if(standalone){
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
        assert(std::strcmp(row->acceptedRevision,candidate)==0&&row->completed==1);
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
    char first[129]{},second[129]{};std::memset(first,'x',128);std::memset(second,'x',128);second[127]='y';
    event.phase=RuntimeStatusPhase::Encoded;event.stageId=first;observeRuntimeStatus(event);event.stageId=second;observeRuntimeStatus(event);
    assert(row->stages==4&&std::strcmp(row->rows[2].id,first)==0&&std::strcmp(row->rows[3].id,second)==0);
    const auto sequence=row->sequence;auto* header=reinterpret_cast<Header*>(page);
    const auto lease=header->leaseUntil;__atomic_store_n(&header->leaseUntil,uint64_t(0),__ATOMIC_RELEASE);
    observeRuntimeStatus(event);assert(row->sequence==sequence);
    observeRuntimeAdmission(event.context,"frame-owner-missing");assert(row->sequence==sequence&&row->admission.counts[1]==32);
    __atomic_store_n(&header->leaseUntil,lease,__ATOMIC_RELEASE);
    requestRuntimeStatusPoll(false);observeRuntimeStatus(event);assert(row->sequence==sequence);
    assert(allocations.load()==before);
    munmap(page,pageSize);
    if(standalone){assert(unlink(ownedFile)==0);assert(rmdir(directory)==0);}
}

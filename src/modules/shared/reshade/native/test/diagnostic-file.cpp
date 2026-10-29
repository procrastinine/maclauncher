#include "diagnostic-file.hpp"
#include "fixture-files.hpp"
#include "diagnostics.hpp"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mach/mach.h>
#include <sys/wait.h>
#include <thread>
#include <chrono>

namespace {
unsigned threads(){
    thread_act_array_t values=nullptr;mach_msg_type_number_t count=0;
    assert(task_threads(mach_task_self(),&values,&count)==KERN_SUCCESS);
    for(unsigned i=0;i<count;++i)mach_port_deallocate(mach_task_self(),values[i]);
    vm_deallocate(mach_task_self(),reinterpret_cast<vm_address_t>(values),count*sizeof(thread_t));
    return count;
}
unsigned descriptors(){unsigned count=0;for(int fd=0;fd<128;++fd)if(fcntl(fd,F_GETFD)>=0)++count;return count;}
int descriptorFor(const std::string &path){
    struct stat named{};assert(stat(path.c_str(),&named)==0);
    for(int fd=3;fd<256;++fd){struct stat value{};if(fstat(fd,&value)==0&&value.st_dev==named.st_dev&&value.st_ino==named.st_ino)return fd;}
    assert(false);return -1;
}
std::string readFile(const std::string &path){
    const int fd=open(path.c_str(),O_RDONLY|O_CLOEXEC);assert(fd>=0);
    std::string result;char bytes[1024];ssize_t count;
    while((count=read(fd,bytes,sizeof(bytes)))>0)result.append(bytes,size_t(count));
    assert(count==0);close(fd);return result;
}
}
int main(int argc,char **argv){
    if(argc==2&&std::strcmp(argv[1],"--disabled")==0){
        unsetenv("RESHADE_DIAGNOSTICS");unsetenv("RESHADE_GPU_TIMING");
        const auto before=threads();
        assert(!macfx::diagnosticsEnabled());assert(!macfx::gpuTimingEnabled());
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::Hooks);macfx::diagnosticEvent(macfx::DiagnosticStage::MetalFrame);}
        macfx::recordGpuDuration("disabled",1,1,1,true);
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        const auto after=threads();assert(before==after);
        std::printf("disabled diagnostics: enabled=0 gpuTiming=0 threadsBefore=%u threadsAfter=%u; no output path or writer created\n",before,after);
        return 0;
    }
    if(argc==2&&std::strcmp(argv[1],"--hooks")==0){
        char directory[1024];temporaryPath(directory,"macfx-diagnostic-hooks-XXXXXX");assert(mkdtemp(directory));
        const auto prefix=std::string(directory)+"/events",path=prefix+"."+std::to_string(getpid())+".jsonl";
        setenv("RESHADE_DIAGNOSTICS",prefix.c_str(),1);unsetenv("RESHADE_GPU_TIMING");
        const auto beforeThreads=threads(),beforeDescriptors=descriptors();
        {macfx::DiagnosticScope hooks(macfx::DiagnosticStage::Hooks,7);}
        macfx::diagnosticEvent(macfx::DiagnosticStage::Hooks,8);
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        assert(access(path.c_str(),F_OK)!=0);assert(threads()==beforeThreads);assert(descriptors()==beforeDescriptors);
        std::printf("Hooks only: no file, threads=%u, descriptors=%u unchanged\n",beforeThreads,beforeDescriptors);
        macfx::diagnosticEvent(macfx::DiagnosticStage::MetalFrame,9);
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
        std::string content;
        do{if(access(path.c_str(),F_OK)==0)content=readFile(path);
            if(content.find("metal-frame")!=std::string::npos)break;
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }while(std::chrono::steady_clock::now()<deadline);
        assert(content.find("\"kind\":\"session\"")!=std::string::npos);
        assert(content.find("\"stage\":\"hooks\"")!=std::string::npos&&content.find("metal-frame")!=std::string::npos);
        std::fwrite(content.data(),1,content.size(),stdout);
        unlink(path.c_str());rmdir(directory);
        std::puts("First actual graphics event starts diagnostics and preserves buffered Hooks records");return 0;
    }
    assert(argc==1);
    char directory[1024];temporaryPath(directory,"macfx-diagnostic-file-XXXXXX");assert(mkdtemp(directory));
    const std::string path=std::string(directory)+"/events.jsonl";
    int replacement=-1,readEnd=-1;
    {
        macfx::DiagnosticFile output(path);assert(output);assert(output.append("seed\n"));
        const auto fd=descriptorFor(path);assert((fcntl(fd,F_GETFD)&FD_CLOEXEC)!=0);
        const auto child=fork();assert(child>=0);
        if(child==0)_exit(output.append("child must not write\n")?1:0);
        int status=0;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
        assert(readFile(path)=="seed\n");
        int pipeEnds[2];assert(pipe(pipeEnds)==0);readEnd=pipeEnds[0];replacement=fd;
        assert(fcntl(readEnd,F_SETFL,O_NONBLOCK)==0);
        assert(close(fd)==0);assert(dup2(pipeEnds[1],replacement)==replacement);close(pipeEnds[1]);
        assert(!output.append("{\"kind\":\"must-not-enter-host-pipe\"}\n"));
        char byte;assert(read(readEnd,&byte,1)==-1&&errno==EAGAIN);
    }
    assert(fcntl(replacement,F_GETFD)>=0); // Destruction must not close the host's reused fd.
    assert(write(replacement,"host",4)==4);char bytes[8]{};assert(read(readEnd,bytes,sizeof(bytes))==4&&std::strcmp(bytes,"host")==0);
    close(replacement);close(readEnd);assert(readFile(path)=="seed\n");
    const std::string link=std::string(directory)+"/link",fifo=std::string(directory)+"/fifo";
    assert(symlink(path.c_str(),link.c_str())==0);assert(mkfifo(fifo.c_str(),0600)==0);
    assert(!macfx::DiagnosticFile(link));assert(!macfx::DiagnosticFile(fifo));
    unlink(link.c_str());unlink(fifo.c_str());unlink(path.c_str());rmdir(directory);
    std::puts("diagnostic file: regular append, CLOEXEC, fork ownership, reused host pipe, destructor ownership, symlink and FIFO rejection passed");
}

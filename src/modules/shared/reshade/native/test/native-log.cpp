#include "log.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <mach/mach.h>
#include <new>
#include <sys/wait.h>

namespace {
std::atomic<unsigned> allocations{0};
int replaced=-1,readEnd=-1;
unsigned threads(){thread_act_array_t values=nullptr;mach_msg_type_number_t count=0;assert(task_threads(mach_task_self(),&values,&count)==KERN_SUCCESS);
    for(unsigned i=0;i<count;++i)mach_port_deallocate(mach_task_self(),values[i]);
    vm_deallocate(mach_task_self(),reinterpret_cast<vm_address_t>(values),count*sizeof(thread_t));return count;}
unsigned descriptors(){unsigned count=0;for(int fd=0;fd<256;++fd)if(fcntl(fd,F_GETFD)>=0)++count;return count;}
int descriptorFor(const std::string &path){struct stat named{};assert(stat(path.c_str(),&named)==0);
    for(int fd=3;fd<256;++fd){struct stat value{};if(fstat(fd,&value)==0&&value.st_dev==named.st_dev&&value.st_ino==named.st_ino)return fd;}assert(false);return -1;}
void afterLoggerDestruction(){
    assert(replaced>=0&&fcntl(replaced,F_GETFD)>=0);
    assert(write(replaced,"after",5)==5);char value[8]{};assert(read(readEnd,value,sizeof(value))==5&&std::strcmp(value,"after")==0);
    close(replaced);close(readEnd);std::puts("logger destruction leaves reused host descriptor intact");
}
}
void *operator new(std::size_t size){allocations.fetch_add(1,std::memory_order_relaxed);if(auto value=std::malloc(size?size:1))return value;throw std::bad_alloc();}
void *operator new[](std::size_t size){return ::operator new(size);}
void operator delete(void *value)noexcept{std::free(value);}
void operator delete[](void *value)noexcept{std::free(value);}
void operator delete(void *value,std::size_t)noexcept{std::free(value);}
void operator delete[](void *value,std::size_t)noexcept{std::free(value);}
int main(int argc,char **argv){
    assert(argc==2);
    char directory[1024];temporaryPath(directory,"macfx-native-log-XXXXXX");assert(mkdtemp(directory));
    const auto path=std::string(directory)+"/native.log";
    setenv("RESHADE_LOG",path.c_str(),1);unsetenv("RESHADE_TRACE");
    if(std::strcmp(argv[1],"off")==0){
        const auto beforeAllocations=allocations.load(),beforeThreads=threads(),beforeFds=descriptors();
        for(unsigned i=0;i<1000000;++i)if(macfx::nativeTraceEnabled())macfx::nativeLog("ReShade macOS library loaded");
        const auto afterAllocations=allocations.load();
        assert(afterAllocations==beforeAllocations&&threads()==beforeThreads&&descriptors()==beforeFds&&access(path.c_str(),F_OK)!=0);
        std::printf("trace off: million constructor-info checks, allocations=0 threads=%u descriptors=%u no log file\n",beforeThreads,beforeFds);
    }else if(std::strcmp(argv[1],"file")==0){
        assert(std::atexit(afterLoggerDestruction)==0); // Registered first; runs after static logger destruction.
        macfx::nativeLog("warning one");const auto fd=descriptorFor(path);assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);
        struct stat before{};assert(stat(path.c_str(),&before)==0&&before.st_size>0);
        {const int input=open(path.c_str(),O_RDONLY|O_CLOEXEC);assert(input>=0);char bytes[128]{};
            const auto count=read(input,bytes,sizeof(bytes));close(input);
            assert(count==28&&std::strcmp(bytes,"[ReShade macOS] warning one\n")==0);}
        const auto child=fork();assert(child>=0);if(child==0){macfx::nativeLog("fork child must not append");_exit(0);}
        int status=0;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
        struct stat after{};assert(stat(path.c_str(),&after)==0&&after.st_size==before.st_size);
        int pipeEnds[2];assert(pipe(pipeEnds)==0);readEnd=pipeEnds[0];replaced=fd;
        assert(fcntl(readEnd,F_SETFL,O_NONBLOCK)==0);assert(close(fd)==0);assert(dup2(pipeEnds[1],replaced)==replaced);close(pipeEnds[1]);
        macfx::nativeLog("must not enter host protocol pipe");char byte;assert(read(readEnd,&byte,1)==-1&&errno==EAGAIN);
        assert(fcntl(replaced,F_GETFD)>=0);std::puts("actual nativeLog: configured file format, CLOEXEC, fork drop, reused pipe drop passed");
    }else if(std::strcmp(argv[1],"limit")==0){
        const int fd=open(path.c_str(),O_WRONLY|O_CREAT|O_CLOEXEC,0600);assert(fd>=0);assert(ftruncate(fd,512*1024-100)==0);close(fd);
        macfx::nativeLog(std::string(4000,'x'));macfx::nativeLog("after stopped");
        struct stat value{};assert(stat(path.c_str(),&value)==0&&value.st_size<=512*1024);
        std::printf("configured shared-file size remains bounded: %lld bytes\n",static_cast<long long>(value.st_size));
    }else if(std::strcmp(argv[1],"invalid")==0){
        assert(mkfifo(path.c_str(),0600)==0);macfx::nativeLog("invalid configured file must not redirect");
        const int fd=open(path.c_str(),O_RDONLY|O_NONBLOCK|O_CLOEXEC);assert(fd>=0);char byte;
        assert(read(fd,&byte,1)==0);close(fd);std::puts("invalid configured file is dropped without host stdio redirection");
    }else assert(false);
    unlink(path.c_str());rmdir(directory);
}

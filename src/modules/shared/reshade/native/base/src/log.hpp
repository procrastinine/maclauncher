#pragma once
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <cstdint>
#include <mutex>
#include <string>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace macfx {
// Errors may recur during a failed presentation. Keep diagnostics finite and
// never wait for another process writing the same optional log file.
inline void nativeLog(const std::string &message) {
    struct State {
        std::mutex mutex;std::atomic<bool> stopped{false};size_t bytes=0,messages=0;int file=-1;
        State(){if(const char *path=std::getenv("RESHADE_LOG"))file=open(path,O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC|O_NOFOLLOW,0600);}
        ~State(){if(file>=0)close(file);}
    };
    static State state;
    constexpr size_t maxBytes=512*1024,maxMessages=4096,maxLine=4096;
    if(state.stopped.load(std::memory_order_relaxed))return;
    std::lock_guard<std::mutex> guard(state.mutex);
    if(state.stopped.load(std::memory_order_relaxed))return;
    const std::string marker="[ReShade macOS] Log limit reached; further messages suppressed\n";
    std::string line="[ReShade macOS] "+message.substr(0,maxLine-64)+(message.size()>maxLine-64?" [truncated]":"")+'\n';
    const bool last=++state.messages>=maxMessages||state.bytes+line.size()+marker.size()>maxBytes;
    if(last)line=marker;
    int descriptor=state.file>=0?state.file:STDERR_FILENO;
    if(state.file>=0){
        if(flock(state.file,LOCK_EX|LOCK_NB)!=0)return;
        struct stat status{};
        if(fstat(state.file,&status)!=0||status.st_size<0||uint64_t(status.st_size)+line.size()+marker.size()>maxBytes){
            if(status.st_size>=0&&uint64_t(status.st_size)+marker.size()<=maxBytes)write(descriptor,marker.data(),marker.size());
            state.stopped.store(true,std::memory_order_relaxed);flock(state.file,LOCK_UN);return;
        }
    }
    size_t written=0;
    while(written<line.size()){
        const auto amount=write(descriptor,line.data()+written,line.size()-written);
        if(amount>0)written+=size_t(amount);else if(amount<0&&errno==EINTR)continue;else break;
    }
    state.bytes+=written;if(last)state.stopped.store(true,std::memory_order_relaxed);
    if(state.file>=0)flock(state.file,LOCK_UN);
}
}

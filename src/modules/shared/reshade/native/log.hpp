#pragma once
#include "diagnostic-file.hpp"
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <optional>
#include <os/log.h>
#include <string>

namespace macfx {
inline bool nativeTraceEnabled()noexcept {
    static const bool enabled=[] {const auto value=std::getenv("RESHADE_TRACE");return value&&std::strcmp(value,"1")==0;}();
    return enabled;
}
// Warnings are bounded best effort. Never write to a cached host protocol fd,
// wait for another logger, or redirect a failed configured file to host stdio.
inline void nativeLog(const std::string &message)noexcept {try {
    static const bool configured=[] {const auto path=std::getenv("RESHADE_LOG");return path&&*path;}();
    if(!configured&&!os_log_type_enabled(OS_LOG_DEFAULT,OS_LOG_TYPE_ERROR))return;
    struct State {
        std::mutex mutex;std::atomic<bool> stopped{false};size_t bytes=0,messages=0;
        const pid_t owner=getpid();std::optional<DiagnosticFile> file;
        State(){if(const auto path=std::getenv("RESHADE_LOG");path&&*path)file.emplace(path);}
    };
    static State state;
    // A fork can inherit a locked mutex, as well as a descriptor. Drop first.
    if(getpid()!=state.owner||state.stopped.load(std::memory_order_relaxed))return;
    std::unique_lock<std::mutex> guard(state.mutex,std::try_to_lock);
    if(!guard||state.stopped.load(std::memory_order_relaxed))return;
    constexpr size_t maxBytes=512*1024,maxMessages=4096,maxLine=4096;
    const std::string marker="[ReShade macOS] Log limit reached; further messages suppressed\n";
    std::string line="[ReShade macOS] "+message.substr(0,maxLine-64)+(message.size()>maxLine-64?" [truncated]":"")+'\n';
    const bool last=++state.messages>=maxMessages||state.bytes+line.size()+marker.size()>maxBytes;
    if(last)line=marker;
    if(configured){
        if(!state.file||!bool(*state.file)){state.stopped.store(true,std::memory_order_relaxed);return;}
        const auto result=state.file->appendBounded(line,last?maxBytes:maxBytes-marker.size());
        if(result==DiagnosticFile::AppendResult::Contended)return;
        if(result==DiagnosticFile::AppendResult::Limit)state.file->appendBounded(marker,maxBytes);
        if(result!=DiagnosticFile::AppendResult::Written){state.stopped.store(true,std::memory_order_relaxed);return;}
    }else os_log_error(OS_LOG_DEFAULT,"%{private}s",line.c_str());
    state.bytes+=line.size();if(last)state.stopped.store(true,std::memory_order_relaxed);
}catch(...) {}}
}

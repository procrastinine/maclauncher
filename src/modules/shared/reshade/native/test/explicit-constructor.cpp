#include "diagnostics.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <unistd.h>

int main(int argc,char **argv){
    assert(argc==2||(argc==3&&std::strcmp(argv[2],"--ordinary-off")==0));
    const bool ordinary=argc==3;
    char directory[1024];temporaryPath(directory,"macfx-explicit-constructor-XXXXXX");assert(mkdtemp(directory));
    const std::string prefix=std::string(directory)+"/diagnostics",log=std::string(directory)+"/native.log";
    const auto output=prefix+"."+std::to_string(getpid())+".jsonl";
    if(ordinary){
        for(const auto name:{"RESHADE_EXPLICIT_HOST","RESHADE_DIAGNOSTICS","RESHADE_TRACE","RESHADE_EFFECT","RESHADE_PREPARED_EFFECT","RESHADE_LIVE_EFFECTS","RESHADE_LIVE_CONTROL_FILE","RESHADE_EFFECT_PLAN","RESHADE_FRAME_MULTIPLIER","RESHADE_SPATIAL_METHOD","RESHADE_TEMPORAL_METHOD","RESHADE_WINDOW_STATE","RESHADE_BROWSER_FRAME_STATE","RESHADE_BROWSER_FRAME_TOKEN"})unsetenv(name);
    }else{setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_DIAGNOSTICS",prefix.c_str(),1);}
    setenv("RESHADE_LOG",log.c_str(),1);
    setenv("RESHADE_DIAGNOSTICS_DURATION_MS","100",1);
    unsetenv("RESHADE_GPU_TIMING");
    // An explicit host may carry a launch preparation path, but its exec helper
    // must not read or compile it until an actual frame API is used.
    if(!ordinary)setenv("RESHADE_PREPARED_EFFECT","/not-opened-by-explicit-constructor",1);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){std::fprintf(stderr,"dlopen: %s\n",dlerror());return 1;}
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    assert(access(output.c_str(),F_OK)!=0);assert(access(log.c_str(),F_OK)!=0);
    if(ordinary){std::puts("ordinary All-Off constructor: trace/diagnostics unset, no diagnostic or success log file");rmdir(directory);return 0;}
    std::puts("explicit host constructor: no diagnostic/log file despite enabled diagnostic environment");
    using Event=void(*)(macfx::DiagnosticStage,uintptr_t,unsigned,unsigned)noexcept;
    auto event=reinterpret_cast<Event>(dlsym(library,"_ZN5macfx15diagnosticEventENS_15DiagnosticStageEmjj"));assert(event);
    event(macfx::DiagnosticStage::MetalFrame,123,7,5); // CPU metadata only; no Metal API.
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    std::string content;
    do{
        std::ifstream input(output);content.assign(std::istreambuf_iterator<char>(input),{});
        if(content.find("\"kind\":\"session\"")!=std::string::npos&&content.find("metal-frame")!=std::string::npos)break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }while(std::chrono::steady_clock::now()<deadline);
    assert(content.find("\"kind\":\"session\"")!=std::string::npos&&content.find("metal-frame")!=std::string::npos);
    std::fwrite(content.data(),1,content.size(),stdout);
    std::puts("explicit actual runtime event: lazy bounded diagnostic writer remains available");
    // Detached diagnostics live for the process lifetime; do not dlclose them.
    unlink(output.c_str());unlink(log.c_str());rmdir(directory);
}

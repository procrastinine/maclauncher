#include "diagnostics.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <unistd.h>
int main(){
    char prefix[1024];temporaryPath(prefix,"maclauncher-diagnostic-checkpoint-XXXXXX");const int fd=mkstemp(prefix);assert(fd>=0);close(fd);unlink(prefix);
    setenv("RESHADE_DIAGNOSTICS",prefix,1);setenv("RESHADE_DIAGNOSTICS_DURATION_MS","1000",1);setenv("RESHADE_DIAGNOSTICS_LIMIT","64",1);
    {macfx::DiagnosticScope ordinary(macfx::DiagnosticStage::Hooks);}
    {macfx::DiagnosticScope outer(macfx::DiagnosticStage::WindowResolve,42,0,0,"test.outer");
        {macfx::DiagnosticScope inner(macfx::DiagnosticStage::MetalDrawable,42,32,24,"test.inner");std::this_thread::sleep_for(std::chrono::milliseconds(250));}
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    const std::string file=std::string(prefix)+"."+std::to_string(getpid())+".jsonl";
    std::string content;const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
    while(std::chrono::steady_clock::now()<deadline){std::ifstream input(file);content.assign(std::istreambuf_iterator<char>(input),{});if(content.find("\"kind\":\"stopped\"")!=std::string::npos)break;std::this_thread::sleep_for(std::chrono::milliseconds(25));}
    assert(content.find("\"kind\":\"stopped\"")!=std::string::npos);
    unsigned pending=0,records=0;std::size_t start=0;while(start<content.size()){const auto end=content.find('\n',start);const auto line=content.substr(start,end-start);if(!line.empty())++records;
        if(line.find("\"kind\":\"pending\"")!=std::string::npos){assert(line.find("\"elapsed_ms\":")!=std::string::npos);if(line.find("\"checkpoint\":\"test.inner\"")!=std::string::npos)pending|=1;if(line.find("\"checkpoint\":\"test.outer\"")!=std::string::npos)pending|=2;}
        if(end==std::string::npos)break;start=end+1;
    }
    assert(pending==3);assert(records>0&&records<=64);assert(content.find("\"stage\":\"hooks\"")!=std::string::npos);
    // The runner captures this bounded original JSONL as raw stdout evidence.
    assert(std::fwrite(content.data(),1,content.size(),stdout)==content.size());assert(unlink(file.c_str())==0);
    std::puts("Diagnostic checkpoints: original constructor, nested pending labels, inclusive wall elapsed and existing duration/record budget; no graphics initialization");
}

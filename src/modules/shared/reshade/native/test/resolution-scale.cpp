#include "resolution-scale.hpp"
#include "process-phase.hpp"
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <limits>
#include <string>
namespace {
// Source settings are read once per process: each mode, and each publisher
// control value, runs as a phase with only its launch variables.
int launch(const std::string &mode,const fixture::Environment &settings,const std::vector<std::string> &arguments={}){
    fixture::Environment environment;
    for(const char *name:{"RESHADE_RENDER_HEIGHT","RESHADE_RENDER_MAX_HEIGHT","RESHADE_RENDER_MULTIPLIER","RESHADE_RESOLUTION_MULTIPLIER","RESHADE_RENDER_SOURCE_CONTROL",
        "RESHADE_RENDER_AUTO","RESHADE_RENDER_SOURCE_METHOD","RESHADE_SPATIAL_METHOD"})environment.emplace_back(name,nullptr);
    for(const auto &setting:settings)for(auto &entry:environment)if(!std::strcmp(entry.first,setting.first))entry.second=setting.second;
    std::vector<std::string> words{mode};words.insert(words.end(),arguments.begin(),arguments.end());
    return fixture::runPhase(mode.c_str(),environment,words);
}
}
int main(int argc,char **argv){
    const auto phase=fixture::phase(argc,argv);argc=phase.argc;argv=phase.argv;
    assert(argc>=2);const std::string mode=argv[1];
    if(phase.name.empty()){
        if(mode=="automatic")return launch(mode,{{"RESHADE_RENDER_AUTO","1"},{"RESHADE_RENDER_SOURCE_CONTROL","drawable"}});
        if(mode=="automatic-invalid")return launch(mode,{{"RESHADE_RENDER_AUTO","true"}});
        if(mode=="automatic-conflict")return launch(mode,{{"RESHADE_RENDER_AUTO","1"},{"RESHADE_RENDER_HEIGHT","480"}});
        if(mode=="maximum")return launch(mode,{{"RESHADE_RENDER_MAX_HEIGHT","480"}});
        if(mode=="exact")return launch(mode,{{"RESHADE_RENDER_HEIGHT","480"}});
        if(mode=="divisor")return launch(mode,{{"RESHADE_RENDER_MULTIPLIER","2"}});
        if(mode=="publisher-control"){
            for(const char *control:{"","engine","unknown","drawable"})
                if(const int status=launch(mode,{{"RESHADE_RENDER_MAX_HEIGHT","480"},{"RESHADE_RENDER_SOURCE_CONTROL",*control?control:nullptr}},{*control?control:"none"}))return status;
            return 0;
        }
        return 2;
    }
    // Live snapshots do not modify or consume the cached launch environment.
    macfx::RenderSourceRequest live;live.multiplier=3;
    auto liveSize=macfx::renderSourceSize(live,1920,1080,1920,1080);assert(liveSize.width==640&&liveSize.height==360);
    live={};live.maximum=720;liveSize=macfx::renderSourceSize(live,1920,1080,1920,1080);
    assert(liveSize.width==1280&&liveSize.height==720);
    live={};live.height=480;liveSize=macfx::renderSourceSize(live,1920,1080,1920,1080);
    assert(liveSize.width==854&&liveSize.height==480);
    liveSize=macfx::renderSourceSize({},1920,1080,1920,1080);assert(liveSize.width==1920&&liveSize.height==1080);
    // Existing three-field aggregates remain manual after adding Auto.
    macfx::RenderSourceRequest manualAggregate{{},{},2.0};assert(!manualAggregate.automatic);
    if(mode=="automatic"){
        assert(macfx::resolutionRequested());
        const auto automatic=macfx::launchRenderSourceRequest();assert(automatic.automatic&&!automatic.height&&!automatic.maximum&&!automatic.multiplier);
        auto check=[&](double ow,double oh,double pw,double ph,double w,double h){const auto size=macfx::renderSourceSize(automatic,ow,oh,pw,ph);assert(size.width==w&&size.height==h);};
        check(1920,1080,1920,1080,960,540);
        check(2560,1440,1920,1080,854,480);
        check(3840,2160,960,540,960,540);
        check(7680,4320,960,540,1920,1080); // Active source grows after output resize.
        check(3024,1964,3024,1964,756,491); // Physical Retina extent, no points conversion.
        check(2879,1619,2879,1619,960,540);
        check(1440,2560,1440,2560,480,854);
        check(1920,1080,2560,1080,960,405); // Fitted ultrawide aspect, not output aspect.
        check(1920,1080,720,1280,608,1080); // Portrait letterbox short edge chooses divisor1.
        check(799,599,799,599,799,599);
        check(1001,667,1001,667,1001,667);
        check(1281,811,1281,811,641,406);
        check(800,600,800,600,800,600);
        check(1920,1080,640,360,960,540); // Target is not clamped to already-reduced input.
        check(640,360,1920,1080,640,360);
        check(0,0,640,360,640,360);
        check(1920,1080,0,0,0,0);
        assert(macfx::drawableResolutionRequested());
    }else if(mode=="automatic-invalid"||mode=="automatic-conflict"){
        bool failed=false;try{macfx::launchRenderSourceRequest();}catch(const std::exception&){failed=true;}assert(failed);
    }else if(mode=="maximum"){
        assert(macfx::resolutionRequested());
        auto size=macfx::renderSourceSize(1920,1080,640,360);assert(size.width==640&&size.height==360);
        size=macfx::renderSourceSize(1920,1080,3840,2160);assert(size.width==854&&size.height==480);
        size=macfx::renderSourceSize(1920,1080,800,1200);assert(size.width==320&&size.height==480);
        size=macfx::renderSourceSize(320,200,800,1200);assert(size.width==134&&size.height==200);
        size=macfx::renderSourceSize(100,100,640,360);assert(size.width==100&&size.height==57);
        size=macfx::renderSourceSize(0,0,640,360);assert(size.width==640&&size.height==360);
        size=macfx::renderSourceSize(1920,1080,0,0);assert(size.width==0&&size.height==0);
        size=macfx::renderSourceSize(1920,1080,std::numeric_limits<double>::quiet_NaN(),360);assert(std::isnan(size.width)&&size.height==360);
    }else if(mode=="exact"){
        auto size=macfx::renderSourceSize(1920,1080,640,360);assert(size.width==854&&size.height==480);
    }else if(mode=="divisor"){
        auto size=macfx::renderSourceSize(1920,1080,640,360);assert(size.width==960&&size.height==540);
    }else if(mode=="publisher-control"){
        assert(argc==3&&macfx::resolutionRequested());
        assert(macfx::drawableResolutionRequested()==(std::string(argv[2])=="drawable"));
    }else return 2;
    std::puts("render source resolution: pass");return 0;
}

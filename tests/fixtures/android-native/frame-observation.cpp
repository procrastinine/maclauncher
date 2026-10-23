#include "frame-observation.hpp"
#include "android-log.h"
#include <cstring>
struct Producer {uint64_t real;};
int status(void *opaque,RSPresenterStatus *output){
    output->presentedReal=static_cast<Producer *>(opaque)->real;
    return RS_FRAME_OK;
}
int main(int argc,char **argv){
    if(argc>1){
        if(!std::strcmp(argv[1],"closed")){klj_android_log_initialize();std::fclose(stderr);}
        klj_timing::Reporter reporter;
        reporter.record(1000000000,1001000000,"native","application",{});
        if(!std::strcmp(argv[1],"burst")||!std::strcmp(argv[1],"closed"))reporter.record(1016000000,1017000000,"native","application",{});
        return 0;
    }
    klj_timing::Reporter reporter;
    Producer producer{7};
    klj_timing::Presentation observed{&producer,status,1,2,0,640,480,1280,960};
    reporter.record(1000000000,1001000000,"surfaceflinger","composition",observed);
    reporter.record(2000000000,2001000000,"surfaceflinger","composition",observed);
    observed.generation=2;observed.accepted=3;producer.real=2;
    reporter.record(3000000000,3001000000,"surfaceflinger","composition",observed);
    observed.presenter=nullptr;observed.accepted=4;
    reporter.record(4000000000,4001000000,"surfaceflinger","composition",observed);
    return 0;
}

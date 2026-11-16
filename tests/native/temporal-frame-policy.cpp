#include "temporal-frame-policy.hpp"
#include <cassert>
#include <cstring>
int main(){
 RSTemporalFrame frame{};frame.size=sizeof(frame);frame.version=1;frame.owner=&frame;
 for(unsigned method=RS_TEMPORAL_METALFX;method<=RS_TEMPORAL_METALFX_DENOISED;++method){
  frame.method=method;RSTemporalResult result{};result.size=sizeof(result);result.version=1;int image=0,writes=0;
  auto declined=[](auto*,auto*,auto*r,bool){r->status=RS_TEMPORAL_INVALID;r->encoded=0;std::snprintf(r->reason,sizeof(r->reason),"Scene region rejected");return int(r->status);};
  auto writer=[&](auto*,auto*,auto*r){image=37;++writes;r->encoded=1;r->status=RS_TEMPORAL_OK;return int(r->status);};
  auto report=[](auto&,auto&,auto&,int){};
  assert(macfx::temporalFrameWithFallback(&frame,nullptr,&result,false,declined,writer,report)==RS_TEMPORAL_OK);assert(image==37&&writes==1&&result.encoded);
  // Retained SDK output is already written and must not be replaced.
  image=0;writes=0;macfx::temporalFrameWithFallback(&frame,nullptr,&result,true,declined,writer,report);assert(!writes);
  auto accepted=[](auto*,auto*,auto*r,bool){r->status=RS_TEMPORAL_OK;r->encoded=1;return int(r->status);};
  macfx::temporalFrameWithFallback(&frame,nullptr,&result,false,accepted,writer,report);assert(!writes);
 }
 frame.flags=RS_TEMPORAL_OUTPUT_MOTION;frame.outputWidth=1920;frame.outputHeight=992;
 macfx::temporalOutputMotionView(frame,1920,989);assert(frame.outputWidth==1920&&frame.outputHeight==989);
 frame.outputWidth=1280;frame.outputHeight=720;macfx::temporalOutputMotionView(frame,1920,1080);assert(frame.outputWidth==1280&&frame.outputHeight==720);
 frame.flags=0;frame.outputWidth=1920;frame.outputHeight=1080;macfx::temporalOutputMotionView(frame,1280,720);assert(frame.outputWidth==1920&&frame.outputHeight==1080);
 assert(macfx::sceneRejectionReason("Needs matching renderer depth, motion and camera inputs","Scene region rejected")=="Scene region rejected");
 assert(macfx::sceneRejectionReason("Model unavailable","Scene region rejected")=="Model unavailable");
 assert(macfx::sceneRejectionReason("Needs matching renderer depth, motion and camera inputs",{}).find("Needs matching renderer")==0);
 puts("temporal-frame-policy: pass");
}

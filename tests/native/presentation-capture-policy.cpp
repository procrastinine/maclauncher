// Copyright (c) MacLauncher contributors. MIT license.
#include "presentation-capture-policy.hpp"
#include <cstdio>
#include <cstdlib>
namespace {
struct Result{bool encoded=false,busy=false;};
void require(bool value,const char*reason){if(!value){std::fprintf(stderr,"presentation-capture-policy: %s\n",reason);std::exit(1);}}
unsigned run(Result result,bool revealed,macfx::PresentationFrameOutcome expected){
 unsigned captures=0;require(macfx::presentationFrameWithScreenshot(result,revealed,[&]{++captures;})==expected,"unexpected frame outcome");return captures;
}
}
int main(){
 using macfx::PresentationFrameOutcome;
 // Occluded or hidden output window before the reveal: every frame is declined
 // and the game's drawable is what the window shows.
 require(run({false,true},false,PresentationFrameOutcome::Declined)==1,"a declined frame before the reveal must serve the screenshot from the game's drawable");
 // After the reveal the processed image is displayed; the raw game frame is not the final image.
 require(run({false,true},true,PresentationFrameOutcome::Declined)==0,"a declined frame after the reveal must leave the screenshot to the presented output");
 // An encoded frame publishes the screenshot from the presentation itself.
 require(run({true,false},false,PresentationFrameOutcome::Encoded)==0,"an encoded frame must not add a second capture");
 require(run({true,false},true,PresentationFrameOutcome::Encoded)==0,"an encoded frame must not add a second capture");
 // A failure stops the presentation; the bypass path that follows owns the capture.
 require(run({false,false},false,PresentationFrameOutcome::Failed)==0,"a failed frame must not capture before the presentation stops");
 std::puts("presentation-capture-policy: pass");return 0;
}

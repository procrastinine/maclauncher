#include "window-binding.hpp"
#include <cstdio>
#include <cstdlib>
static unsigned checks;
static void check(bool value){++checks;if(!value){std::fprintf(stderr,"Window binding check %u failed\n",checks);std::exit(1);}}
int main(){@autoreleasepool{
 macfx::LayerBinding binding;
 CALayer *original=[CALayer layer],*replacement=[CALayer layer];
 @autoreleasepool {
  NSView *view=[[NSView alloc]initWithFrame:NSMakeRect(0,0,100,100)];view.layer=original;view.wantsLayer=YES;binding.view=view;
  check(binding.currentView(original)==view);
  // A size change is read from the actual view, not a cached dimensions record.
  view.frame=NSMakeRect(0,0,200,150);check(binding.currentView(original).bounds.size.width==200);
  view.layer=replacement;check(binding.currentView(original)==nil);check(binding.currentView(replacement)==view);
  CALayer *nested=[CALayer layer];[replacement addSublayer:nested];check(binding.currentView(nested)==nil);
  [nested removeFromSuperlayer];check(binding.currentView(nested)==nil);
 }
 check(binding.view==nil);check(binding.currentView(replacement)==nil);
 std::printf("PASS %u live view/layer binding, resize, nested discovery and weak retirement checks\n",checks);
}return 0;}

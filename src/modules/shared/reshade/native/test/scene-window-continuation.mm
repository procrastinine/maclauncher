// Copyright (c) MacLauncher contributors. MIT license.
// A scene without a registered destination continues in the only window that
// a presenter on its device continues scenes in: once, on a final image of
// the scene's output extent, and never after scenes from two producers.
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#include "scene-destination.hpp"
#include <cstdio>
#include <memory>
#include <stdexcept>

static void require(bool value,const char*reason){if(!value)throw std::runtime_error(reason);}
static NSWindow*makeWindow(){
 NSWindow*window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,64,48) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
 window.releasedWhenClosed=NO;return window;
}
static id<MTLTexture>makeTexture(id<MTLDevice>device,unsigned width,unsigned height){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
 descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;descriptor.storageMode=MTLStorageModePrivate;return [device newTextureWithDescriptor:descriptor];
}
struct Scene{id<MTLCommandBuffer>commands;RSTemporalFrame frame{};};
static Scene makeScene(id<MTLCommandQueue>queue,void*owner,uint64_t frameId,id<MTLTexture>color,id<MTLTexture>depth,id<MTLTexture>motion,id<MTLTexture>output){
 Scene scene;scene.commands=[queue commandBuffer];auto&f=scene.frame;f.size=sizeof(f);f.version=1;f.owner=owner;f.commandBuffer=(__bridge void*)scene.commands;
 f.color=(__bridge void*)color;f.depth=(__bridge void*)depth;f.motion=(__bridge void*)motion;f.output=(__bridge void*)output;f.frameId=frameId;
 f.renderWidth=f.maxRenderWidth=uint32_t(color.width);f.renderHeight=f.maxRenderHeight=uint32_t(color.height);f.outputWidth=uint32_t(output.width);f.outputHeight=uint32_t(output.height);
 return scene;
}

int main(){@autoreleasepool{try{
 [NSApplication sharedApplication];
 id<MTLDevice>device=MTLCreateSystemDefaultDevice();require(device!=nil,"No Metal device");id<MTLCommandQueue>queue=[device newCommandQueue];
 auto color=makeTexture(device,32,24),depth=makeTexture(device,32,24),motion=makeTexture(device,32,24),output=makeTexture(device,64,48);
 auto finalImage=makeTexture(device,64,48),otherExtent=makeTexture(device,80,48);
 int producerA=0,producerB=0;
 // The aliasing owner stands in for the producer's prefix execution and scene lease; neither is read here.
 auto anchor=std::make_shared<int>(0);
 std::shared_ptr<macfx::EffectExecution>execution(anchor,reinterpret_cast<macfx::EffectExecution*>(anchor.get()));
 std::shared_ptr<const macfx::EffectSceneLease>lease(anchor,reinterpret_cast<const macfx::EffectSceneLease*>(anchor.get()));
 auto first=makeScene(queue,&producerA,1,color,depth,motion,output);

 require(!macfx::presentedTemporalSceneDestination(first.frame),"A scene without a presenter has no destination");
 NSWindow*gameWindow=makeWindow(),*otherWindow=makeWindow();
 const auto game=macfx::temporalSceneWindow((__bridge void*)gameWindow),other=macfx::temporalSceneWindow((__bridge void*)otherWindow);
 require(game&&other&&game->identity()!=other->identity(),"Windows need scene authorities");
 auto presenter=std::make_shared<int>(0);macfx::noteSceneWindowPresenter(presenter,game,device);
 auto destination=macfx::presentedTemporalSceneDestination(first.frame);
 require(destination&&destination->presented&&destination->window->identity()==game->identity()&&destination->owner==&producerA&&destination->frameId==1,
  "The only presenting window is the destination");

 // A registered destination takes precedence over the presented one.
 require(rsSetTemporalSceneDestinationForTextures(&producerA,(__bridge void*)otherWindow,first.frame.color,first.frame.depth,first.frame.motion,1)==RS_TEMPORAL_OK,"Registration failed");
 const auto registered=macfx::temporalSceneDestination(first.frame,first.frame);
 require(registered&&!registered->presented&&registered->window->identity()==other->identity(),"The registered destination comes first");
 const auto again=macfx::temporalSceneDestination(first.frame,first.frame);require(again&&again->presented,"A registered destination serves one scene");

 // Presenters in two windows are ambiguous; a released presenter no longer counts.
 auto second=std::make_shared<int>(0);macfx::noteSceneWindowPresenter(second,other,device);
 require(!macfx::presentedTemporalSceneDestination(first.frame),"Two presenting windows give no destination");
 second.reset();require(macfx::presentedTemporalSceneDestination(first.frame).has_value(),"A released presenter no longer counts");

 // One final image of the scene's extent continues the scene, once.
 macfx::publishRetainedTemporalSceneContinuation(first.commands,*destination,first.frame,execution,lease);
 require(!macfx::temporalSceneContinuation(game,otherExtent),"A final image of another extent runs the complete graph");
 auto value=macfx::temporalSceneContinuation(game,finalImage);require(value&&value->frameId()==1,"The final image finds the scene");
 [first.commands commit];id<MTLCommandBuffer>present=[queue commandBuffer];
 require(value->ready(present).encoded,"The committed scene is ready for the final image");
 require(value->claim(present,finalImage),"The final image claims the scene");
 require(!macfx::temporalSceneContinuation(game,finalImage),"The next final image without a new scene runs the complete graph");
 [present commit];

 // Scenes from two producers before one final image continue neither.
 auto a=makeScene(queue,&producerA,2,color,depth,motion,output),b=makeScene(queue,&producerB,7,color,depth,motion,output);
 macfx::publishRetainedTemporalSceneContinuation(a.commands,*macfx::presentedTemporalSceneDestination(a.frame),a.frame,execution,lease);
 macfx::publishRetainedTemporalSceneContinuation(b.commands,*macfx::presentedTemporalSceneDestination(b.frame),b.frame,execution,lease);
 require(!macfx::temporalSceneContinuation(game,finalImage),"Two producers before one final image are ambiguous");

 // One producer's newer scene replaces its unclaimed earlier scene.
 auto c=makeScene(queue,&producerA,3,color,depth,motion,output),d=makeScene(queue,&producerA,4,color,depth,motion,output);
 macfx::publishRetainedTemporalSceneContinuation(c.commands,*macfx::presentedTemporalSceneDestination(c.frame),c.frame,execution,lease);
 macfx::publishRetainedTemporalSceneContinuation(d.commands,*macfx::presentedTemporalSceneDestination(d.frame),d.frame,execution,lease);
 value=macfx::temporalSceneContinuation(game,finalImage);require(value&&value->frameId()==4,"The newer scene of one producer continues");
 for(id<MTLCommandBuffer>commands:@[a.commands,b.commands,c.commands,d.commands])[commands commit];
 [d.commands waitUntilCompleted];
 [gameWindow close];[otherWindow close];
 std::puts("Presented scene continuation: pass");return 0;
}catch(const std::exception&error){std::fprintf(stderr,"Presented scene continuation: %s\n",error.what());return 1;}}}

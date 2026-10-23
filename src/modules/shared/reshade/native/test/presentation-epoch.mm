#include "presentation.hpp"
#include "effects-execution.hpp"
#include "live-controls.hpp"
#import <Cocoa/Cocoa.h>
#include <array>
#include <cassert>
#include <cstdio>
#include <fstream>
#include <unistd.h>

@interface EpochLayer : CAMetalLayer
@property(strong) id<CAMetalDrawable> lastDrawable;
@end
@implementation EpochLayer
- (id<CAMetalDrawable>)nextDrawable {auto value=[super nextDrawable];@synchronized(self){if(value)self.lastDrawable=value;}return value;}
@end
namespace {
void idle(double seconds){const auto end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);}
struct Colour final:macfx::ShaderNode {
 bool prefix;float gain=.2f;id<MTLComputePipelineState> pipeline;
 explicit Colour(bool value):prefix(value){}
 void setParameters(const macfx::ShaderParameters&parameters)override{if(auto value=parameters.find("Gain");value!=parameters.end())gain=value->second[0];}
 macfx::ShaderResult prepare(const macfx::ShaderFrame&frame)override{
  if(!pipeline){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void colour(texture2d<float,access::read>a[[texture(0)]],texture2d<float,access::write>b[[texture(1)]],constant float&gain[[buffer(0)]],constant uint&prefix[[buffer(1)]],uint2 p[[thread_position_in_grid]]){if(p.x>=b.get_width()||p.y>=b.get_height())return;float4 v=a.read(p);if(prefix)v.r=gain;else v.b=gain;b.write(v,p);}" options:nil error:&error];assert(library);pipeline=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"colour"] error:&error];assert(pipeline);}
  return {true,{}};
 }
 macfx::ShaderResult encode(const macfx::ShaderFrame&frame)override{prepare(frame);auto encoder=[frame.commands computeCommandEncoder];unsigned channel=prefix;[encoder setComputePipelineState:pipeline];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.target atIndex:1];[encoder setBytes:&gain length:sizeof(gain) atIndex:0];[encoder setBytes:&channel length:sizeof(channel) atIndex:1];[encoder dispatchThreads:MTLSizeMake(frame.target.width,frame.target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];return {true,{}};}
};
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
NSDictionary *shader(NSString *name,double gain){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":[@"/proof/" stringByAppendingString:name],@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{@"Gain":@[@(gain)]},@"preservesCoordinates":@YES};}
void publish(NSString *file,NSString *revision,NSString *model,double prefix,double suffix,bool generated=true){
 auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":@{@"frameMultiplier":@3,@"framePacing":@"fixed",@"targetFps":@60,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}};
 auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":generated?@[shader(@"prefix",prefix),generation,shader(@"suffix",suffix)]:@[shader(@"suffix",suffix)]};
 assert([[NSJSONSerialization dataWithJSONObject:document options:0 error:nil]writeToFile:file atomically:YES]);idle(.12);
}
void commit(id<MTLCommandBuffer>commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
void awaitFrame(macfx::FramePresenter&presenter,uint64_t frame){const auto deadline=CACurrentMediaTime()+2;while(presenter.snapshot().lastPresentedFrame!=frame&&CACurrentMediaTime()<deadline)idle(.005);assert(presenter.snapshot().lastPresentedFrame==frame);}
void verifyBlue(EpochLayer *layer,id<MTLCommandQueue>queue,unsigned expected){
 id<CAMetalDrawable>drawable;@synchronized(layer){drawable=layer.lastDrawable;}assert(drawable);
 auto commands=[queue commandBuffer];auto bytes=[queue.device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto copy=[commands blitCommandEncoder];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(20,20,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];commit(commands);assert(std::abs(int(static_cast<unsigned char*>(bytes.contents)[0])-int(expected))<=2);
}
void controls(NSString *file,float gain,bool effect){
 macfx::LivePacket packet{};memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=3;packet.flags=1|(effect?8:0);packet.spatial=0;packet.lsfgMode=3;packet.flowScale=.5;memset(packet.effectKey,'a',64);memset(packet.revision,'b',64);packet.count=1;strcpy(packet.uniforms[0].name,"Gain");packet.uniforms[0].count=1;packet.uniforms[0].values[0]=gain;
 assert([[NSData dataWithBytes:&packet length:sizeof(packet)]writeToFile:file atomically:YES]);idle(.12);
}
}
namespace macfx {
std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec&spec){return std::make_shared<Colour>(spec.selection.file=="/proof/prefix");}
// Exercise legacy packet history without requiring the shader compiler. Its
// GPU input changes exactly when this packet's enabled/uniform fields change.
FrameResult processFrameWithDepth(void*,id<MTLCommandBuffer>commands,const SpatialFrame&frame,SpatialMethod,const DepthFrame*,bool){
 Colour shader(false);const auto packet=livePacket();shader.gain=packet&&(packet->flags&8)&&packet->count?packet->uniforms[0].values[0]:.1f;
 auto result=shader.encode({commands,frame.source,frame.output,frame.frameId});FrameResult value;value.encoded=result.encoded;value.effects=packet&&(packet->flags&8);return value;
}
}
int main(int argc,char **argv){@autoreleasepool{
 assert(argc==2);const auto originalModel=[NSString stringWithUTF8String:argv[1]];assert([NSFileManager.defaultManager fileExistsAtPath:originalModel]);
 char temporary[]="/tmp/maclauncher-presentation-epoch-XXXXXX";assert(mkdtemp(temporary));auto directory=[NSString stringWithUTF8String:temporary],plan=[directory stringByAppendingPathComponent:@"plan.json"],control=[directory stringByAppendingPathComponent:@"controls.bin"];
 const auto model=[directory stringByAppendingPathComponent:@"resident-model.dll"];assert([NSFileManager.defaultManager createSymbolicLinkAtPath:model withDestinationPath:originalModel error:nil]);
 setenv("RESHADE_EXPLICIT_HOST","1",1);[NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
 auto layer=[EpochLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.displaySyncEnabled=YES;window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(128,96);
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:128 height:96 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto source=[device newTextureWithDescriptor:descriptor];std::array<unsigned char,128*96*4>pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=40;pixels[i+1]=80;pixels[i+2]=120;pixels[i+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,128,96) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:512];
 setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);publish(plan,@"a",model,.3,.2);
 macfx::EffectPlanExecutor identity;auto candidate=[queue commandBuffer];macfx::ShaderFrame frame{candidate,source,source};auto original=identity.prepare(frame,true);assert(original.execution&&original.execution->generator());
 int owner=0;macfx::FramePresenter presenter(layer,&owner);uint64_t id=0;
 for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);idle(.05);}idle(.12);assert(presenter.snapshot().presentedGenerated>0);
 auto held=[queue commandBuffer];const auto heldId=++id;assert(presenter.submit(held,source,heldId,CACurrentMediaTime()).encoded);const auto before=presenter.snapshot();
 publish(plan,@"c",model,.3,.8);candidate=[queue commandBuffer];frame.commands=candidate;auto suffix=identity.prepare(frame,true);assert(suffix.execution&&suffix.execution!=original.execution&&suffix.execution->generator()==original.execution->generator());
 auto probe=[queue commandBuffer];const auto rejected=presenter.submit(probe,source,id+1,CACurrentMediaTime());assert(!rejected.encoded&&rejected.busy);commit(held);idle(.16);
 const auto retired=presenter.snapshot();assert(retired.lastPresentedFrame!=heldId&&retired.presentedGenerated==before.presentedGenerated&&retired.presentedReal==before.presentedReal&&retired.dropped>before.dropped);
 auto fresh=[queue commandBuffer];assert(presenter.submit(fresh,source,++id,CACurrentMediaTime()).encoded);commit(fresh);awaitFrame(presenter,id);verifyBlue(layer,queue,204);assert(presenter.snapshot().presentedGenerated>retired.presentedGenerated&&presenter.snapshot().reason.empty());
 assert([NSFileManager.defaultManager removeItemAtPath:model error:nil]);publish(plan,@"d",model,.6,.8);candidate=[queue commandBuffer];frame.commands=candidate;auto prefix=identity.prepare(frame,true);assert(prefix.execution&&prefix.execution->generator()==suffix.execution->generator()&&prefix.execution->generationInputIdentity()!=suffix.execution->generationInputIdentity());
 const auto beforePrefix=presenter.snapshot().presentedGenerated;
 for(unsigned warming=0;warming<3;++warming){idle(.06);auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);awaitFrame(presenter,id);if(warming<2)assert(presenter.snapshot().presentedGenerated==beforePrefix);}
 idle(.1);assert(presenter.snapshot().presentedGenerated>beforePrefix&&presenter.snapshot().reason.empty());presenter.stop();
 // An effects-only drawable is already scheduled in the borrowed buffer;
 // adopting a replacement must retire it even when its host commits it late.
 publish(plan,@"e",model,0,.2,false);int directOwner=0;macfx::FramePresenter direct(layer,&directOwner);
 auto late=[queue commandBuffer];assert(direct.submit(late,source,1,CACurrentMediaTime()).encoded);
 publish(plan,@"f",model,0,.8,false);auto current=[queue commandBuffer];assert(direct.submit(current,source,2,CACurrentMediaTime()).encoded);commit(current);awaitFrame(direct,2);verifyBlue(layer,queue,204);const auto shown=direct.snapshot();commit(late);idle(.1);const auto afterLate=direct.snapshot();assert(afterLate.lastPresentedFrame==2&&afterLate.presentedReal==shown.presentedReal&&afterLate.completedReal==shown.completedReal&&afterLate.dropped>shown.dropped);direct.stop();unsetenv("RESHADE_EFFECT_PLAN");
 // Legacy edits have null execution pointers, so epochs must also cover them.
 setenv("RESHADE_CONTROL_FILE",control.fileSystemRepresentation,1);controls(control,.2,true);macfx::PresenterConfig config;macfx::LsfgConfig generation;generation.modelPath=argv[1];generation.performance=true;generation.flowScale=.5;generation.multiplier=3;config.generation=generation;int legacyOwner=0;macfx::FramePresenter legacy(layer,&legacyOwner,config);id=0;
 for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];assert(legacy.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);idle(.05);}idle(.12);assert(legacy.snapshot().presentedGenerated>0);
 for(unsigned change=0;change<2;++change){
  auto old=[queue commandBuffer];const auto oldId=++id;assert(legacy.submit(old,source,oldId,CACurrentMediaTime()).encoded);const auto accepted=legacy.snapshot();controls(control,.8,change==0);
  auto blocked=[queue commandBuffer];const auto busy=legacy.submit(blocked,source,id+1,CACurrentMediaTime());assert(!busy.encoded&&busy.busy);commit(old);idle(.16);const auto stale=legacy.snapshot();assert(stale.lastPresentedFrame!=oldId&&stale.presentedGenerated==accepted.presentedGenerated&&stale.presentedReal==accepted.presentedReal&&stale.dropped>accepted.dropped);
  const auto generated=stale.presentedGenerated;for(unsigned warming=0;warming<2;++warming){idle(.06);auto commands=[queue commandBuffer];assert(legacy.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);awaitFrame(legacy,id);assert(legacy.snapshot().presentedGenerated==generated);}
  idle(.06);auto ready=[queue commandBuffer];assert(legacy.submit(ready,source,++id,CACurrentMediaTime()).encoded);commit(ready);awaitFrame(legacy,id);assert(legacy.snapshot().presentedGenerated>generated&&legacy.snapshot().reason.empty());verifyBlue(layer,queue,change==0?204:26);idle(.1);
 }
 legacy.stop();unsetenv("RESHADE_CONTROL_FILE");assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);[window close];std::puts("Presenter epochs: stale held batches retired, suffix history reused, prefix resident model reused with fresh history after its private alias disappeared, legacy uniforms/toggles reset with monotonic IDs");
}}

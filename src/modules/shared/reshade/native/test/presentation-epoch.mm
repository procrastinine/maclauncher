#include "presentation.hpp"
#include "fixture-files.hpp"
#include "fixture-colour-shaders.hpp"
#include "effects-execution.hpp"
#include "live-controls.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#include <array>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <fstream>
#include <sys/mman.h>
#include <unistd.h>

@interface EpochLayer : CAMetalLayer
@property(strong) id<CAMetalDrawable> lastDrawable;
@property unsigned requests;
@end
@implementation EpochLayer
- (id<CAMetalDrawable>)nextDrawable {@synchronized(self){++self.requests;}auto value=[super nextDrawable];@synchronized(self){if(value)self.lastDrawable=value;}return value;}
@end
namespace {
void idle(double seconds){const auto end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);}
NSString *shaderRoot;
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
NSDictionary *shader(NSString *name,double gain){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":fixture::colourShaderPath(shaderRoot,[name isEqual:@"prefix"]),@"key":hex(@"a"),@"revision":hex(@"b"),@"parameters":@{@"Gain":@[@(gain)]},@"preservesCoordinates":@YES};}
void publish(NSString *file,NSString *revision,NSString *model,double prefix,double suffix,bool generated=true){
 auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":@{@"frameMultiplier":@3,@"framePacing":@"fixed",@"targetFps":@60,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}};
 auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":generated?@[shader(@"prefix",prefix),generation,shader(@"suffix",suffix)]:@[shader(@"suffix",suffix)]};
 assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],file));idle(.12);
}
void commit(id<MTLCommandBuffer>commands){[commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);}
// LSFG image storage initializes off the frame path. Until it is ready,
// preparation reports it as preparing and the presenter declines frames as busy
// or shows real frames only.
macfx::EffectExecutionSelection generating(macfx::EffectPlanExecutor&executor,const macfx::ShaderFrame&frame){
 for(const auto deadline=CACurrentMediaTime()+30;;){const auto selected=executor.prepare(frame,true);if(!selected.preparing)return selected;
  if(CACurrentMediaTime()>=deadline)std::fprintf(stderr,"Generation preparation: %s\n",selected.error.c_str());assert(CACurrentMediaTime()<deadline);idle(.01);}
}
// The presenter checks begin once it has presented a generated frame.
void ready(macfx::FramePresenter&presenter,id<MTLCommandQueue>queue,id<MTLTexture>source,uint64_t&id){
 const auto generated=presenter.snapshot().presentedGenerated;
 for(const auto deadline=CACurrentMediaTime()+30;;){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,++id,CACurrentMediaTime());commit(commands);idle(.05);
  if(result.encoded&&presenter.snapshot().presentedGenerated>generated)return;
  if(!(result.encoded||result.busy)||CACurrentMediaTime()>=deadline)std::fprintf(stderr,"Presenter preparation: encoded=%d reason=%s status=%s\n",result.encoded,result.reason.c_str(),presenter.snapshot().reason.c_str());
  assert((result.encoded||result.busy)&&CACurrentMediaTime()<deadline);}
}
void awaitFrame(macfx::FramePresenter&presenter,uint64_t frame){const auto deadline=CACurrentMediaTime()+2;while(presenter.snapshot().lastPresentedFrame!=frame&&CACurrentMediaTime()<deadline)idle(.005);assert(presenter.snapshot().lastPresentedFrame==frame);}
void verifyBlue(EpochLayer *layer,id<MTLCommandQueue>queue,unsigned expected){
 id<CAMetalDrawable>drawable;@synchronized(layer){drawable=layer.lastDrawable;}assert(drawable);
 auto commands=[queue commandBuffer];auto bytes=[queue.device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto copy=[commands blitCommandEncoder];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(20,20,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];commit(commands);assert(std::abs(int(static_cast<unsigned char*>(bytes.contents)[0])-int(expected))<=2);
}
void controls(NSString *file,float gain,bool effect){
 macfx::LivePacket packet{};memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=3;packet.flags=1|(effect?8:0);packet.spatial=0;packet.lsfgMode=3;packet.flowScale=.5;memset(packet.effectKey,'a',64);memset(packet.revision,'b',64);packet.count=1;strcpy(packet.uniforms[0].name,"Gain");packet.uniforms[0].count=1;packet.uniforms[0].values[0]=gain;
 assert(replaceFile([NSData dataWithBytes:&packet length:sizeof(packet)],file));idle(.12);
}
void visibilityNeed(bool value,const char*reason){if(!value){std::fprintf(stderr,"Visibility: %s\n",reason);std::fflush(stderr);std::_Exit(1);}}
template<class Predicate>void visibilityWait(Predicate ready,const char*reason){const auto until=CACurrentMediaTime()+8;while(!ready()){visibilityNeed(CACurrentMediaTime()<until,reason);idle(.005);}}
void visibilityCommit(id<MTLCommandBuffer>commands){[commands commit];visibilityWait([&]{return commands.status>=MTLCommandBufferStatusCompleted;},"GPU completion expired");visibilityNeed(commands.status==MTLCommandBufferStatusCompleted,"GPU command failed");}
void visibilityPixels(EpochLayer*layer,id<MTLCommandQueue>queue,unsigned green){
 id<CAMetalDrawable>drawable;@synchronized(layer){drawable=layer.lastDrawable;}visibilityNeed(drawable!=nil,"Completed drawable missing");
 auto bytes=[queue.device newBufferWithLength:128*96*4 options:MTLResourceStorageModeShared];visibilityNeed(bytes!=nil,"Pixel verification buffer");
 auto commands=[queue commandBuffer];auto copy=[commands blitCommandEncoder];
 [copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(128,96,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:512 destinationBytesPerImage:128*96*4];[copy endEncoding];visibilityCommit(commands);
 const auto pixel=static_cast<const unsigned char*>(bytes.contents);
 for(unsigned i=0;i<128*96*4;i+=4)visibilityNeed(std::abs(int(pixel[i])-51)<=3&&std::abs(int(pixel[i+1])-int(green))<=3&&std::abs(int(pixel[i+2])-77)<=3&&pixel[i+3]==255,"Processed RGBA pixels changed");
}
void visibility(macfx::FramePresenter&presenter,EpochLayer*layer,NSWindow*window,id<MTLCommandQueue>queue,id<MTLTexture>source){
 using namespace macfx::runtime_status;
 int fd=open(getenv("RESHADE_RUNTIME_STATUS_FILE"),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);visibilityNeed(fd>=0,"Inspector page missing");
 auto page=static_cast<const char*>(mmap(nullptr,pageSize,PROT_READ,MAP_SHARED,fd,0));close(fd);visibilityNeed(page!=MAP_FAILED,"Inspector page mapping");
 const auto preparations=std::make_shared<std::atomic<unsigned>>(0);presenter.setPreparationObserver([preparations](const macfx::EffectPreparationNotice&){++*preparations;});
 struct Sample {std::array<uint64_t,12>counts{};bool operator==(const Sample&other)const{return counts==other.counts;}};
 const auto sample=[&]{Sample result;const auto status=presenter.snapshot();result.counts[0]=status.encoded;result.counts[1]=status.completedReal;result.counts[2]=status.presentedReal;result.counts[3]=status.presentedGenerated;result.counts[11]=preparations->load();@synchronized(layer){result.counts[4]=layer.requests;}
  for(unsigned i=0;i<slotCount;++i){const auto row=reinterpret_cast<const Context*>(page+headerSize+i*slotSize);Context current{};bool stable=false;
   for(unsigned attempt=0;attempt<8&&!stable;++attempt){const auto sequence=__atomic_load_n(&row->sequence,__ATOMIC_ACQUIRE);if(sequence&1)continue;memcpy(&current,row,sizeof(current));stable=sequence==__atomic_load_n(&row->sequence,__ATOMIC_ACQUIRE);}
   if(!stable||current.pid!=uint32_t(getpid()))continue;
   for(unsigned n=0;n<current.stages&&n<stageCount;++n)for(unsigned stage=0;stage<3;++stage)if(!strcmp(current.rows[n].id,stage==0?"prefix":stage==1?"generation":"suffix")){result.counts[5+stage]+=current.rows[n].encoded;result.counts[8+stage]+=current.rows[n].completed;}
  }return result;
 };
 uint64_t frame=0;
 // Default/unknown output visibility remains usable, including an inactive
 // app whose actual window is visible. No activation or global input is used.
 visibilityNeed(window.visible&&!NSApp.active,"An inactive visible window is required");
 const auto until=CACurrentMediaTime()+30;
 while(!presenter.snapshot().presentedGenerated){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,++frame,CACurrentMediaTime());visibilityNeed(result.encoded||result.busy,"Initial graph failed");visibilityCommit(commands);idle(.05);visibilityNeed(CACurrentMediaTime()<until,"Initial generated presentation expired");}
 visibilityPixels(layer,queue,80);const auto active=sample();visibilityNeed(active.counts[5]&&active.counts[6]&&active.counts[7],"Actual prefix/FG/suffix work was not observed");
 struct Record {std::atomic<unsigned>calls{0};uint32_t outcome=0;} retirement;
 RSPresentationObserver observer{sizeof(observer),RS_TARGET_ABI_VERSION,&retirement,[](void*context,uint64_t,double shown,double,uint32_t outcome){auto*record=static_cast<Record*>(context);visibilityNeed(shown==0&&outcome==RS_PRESENT_CANCELLED,"Hidden unissued frame was presented");record->outcome=outcome;visibilityNeed(record->calls.fetch_add(1)==0,"GPU lease retired twice");}};
 auto held=[queue commandBuffer];const auto admitted=presenter.submitAtTimeObserved(held,source,++frame,CACurrentMediaTime(),nullptr,&observer);visibilityNeed(admitted.encoded,"Retained source frame was not admitted");
 presenter.setOutputVisible(false);idle(.03);visibilityNeed(!retirement.calls.load()&&held.status<MTLCommandBufferStatusCommitted,"Admitted lease retired before its GPU commands");
 visibilityCommit(held);visibilityWait([&]{return retirement.calls.load()==1;},"Hidden admitted lease did not drain");
 Sample quiet=sample();double stableSince=CACurrentMediaTime();const auto quietUntil=CACurrentMediaTime()+3;
 for(;;){idle(.02);const auto current=sample();if(!(current==quiet)){quiet=current;stableSince=CACurrentMediaTime();}if(CACurrentMediaTime()-stableSince>.1)break;visibilityNeed(CACurrentMediaTime()<quietUntil,"Hidden work did not drain");}
 const auto retained=layer.superlayer;const bool hidden=layer.hidden;
 std::array<unsigned char,128*96*4>pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=40;pixels[i+1]=200;pixels[i+2]=120;pixels[i+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,128,96) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:512];
 const uint64_t retry=frame+1;
 for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,retry,CACurrentMediaTime());visibilityNeed(!result.encoded&&result.busy&&commands.status==MTLCommandBufferStatusNotEnqueued,"Hidden admission changed work/identity");idle(.02);}
 visibilityNeed(sample()==quiet,"Hidden model/FG/encoding/drawable/presentation counters advanced");visibilityNeed(!presenter.snapshot().stopped&&presenter.snapshot().reason.empty()&&window.contentView.layer==layer&&layer.superlayer==retained&&layer.hidden==hidden,"Hidden output or accepted graph was retired");visibilityPixels(layer,queue,80);
 presenter.setOutputVisible(true);const auto generated=presenter.snapshot().presentedGenerated;
 for(unsigned n=0;n<3;++n){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,++frame,CACurrentMediaTime());visibilityNeed(result.encoded,"Visible fresh source was not admitted");visibilityCommit(commands);
  visibilityWait([&]{return presenter.snapshot().lastPresentedFrame==frame;},"Visible fresh output did not present");visibilityPixels(layer,queue,200);if(n<2)visibilityNeed(presenter.snapshot().presentedGenerated==generated,"Generation bridged the hidden history interval");idle(.06);
 }
 visibilityWait([&]{return presenter.snapshot().presentedGenerated>generated;},"Generation did not resume after fresh history");
 visibilityNeed(!NSApp.active&&window.visible&&!presenter.snapshot().stopped&&presenter.snapshot().reason.empty()&&retirement.calls.load()==1,"Inactive visible resume/lease ownership changed");visibilityNeed(preparations->load()==quiet.counts[11],"Visibility rebuilt prepared resources");
 munmap(const_cast<char*>(page),pageSize);presenter.stop();std::puts("Visibility: actual inactive visible output; hidden graph/FG idle after admitted GPU drain; retained processed pixels; fresh output and generation history reset/resume");
}
}
int main(int argc,char **argv){@autoreleasepool{
 // The explicit host, plan and control files are launch settings, so the
 // plan presenter checks and the legacy presenter checks, which read no plan,
 // run as phases launched with their own.
 const auto phase=fixture::phase(argc,argv);
 if(phase.name.empty()){
  const bool visibilityOnly=argc==3&&!strcmp(argv[1],"--visibility");assert(visibilityOnly||argc==2);const char*modelArgument=argv[visibilityOnly?2:1];const auto originalModel=[NSString stringWithUTF8String:modelArgument];assert([NSFileManager.defaultManager fileExistsAtPath:originalModel]);
  char temporary[1024];temporaryPath(temporary,"maclauncher-presentation-epoch-XXXXXX");assert(mkdtemp(temporary));auto directory=[NSString stringWithUTF8String:temporary];fixture::writeColourShaders(directory);
  assert([NSFileManager.defaultManager createSymbolicLinkAtPath:[directory stringByAppendingPathComponent:@"resident-model.dll"] withDestinationPath:originalModel error:nil]);
  const char *control=[directory stringByAppendingPathComponent:@"controls.bin"].fileSystemRepresentation;
  const auto statusFile=[directory stringByAppendingPathComponent:@"status.bin"];
  if(visibilityOnly){using namespace macfx::runtime_status;auto bytes=[NSMutableData dataWithLength:pageSize];auto header=static_cast<Header*>(bytes.mutableBytes);memcpy(header->magic,"MLFXSTS1",8);header->version=schema;header->bytes=pageSize;header->leaseUntil=uint64_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())+120000;memset(header->token,'a',64);memcpy(header->launchId,"visibility",10);header->launchIdLength=10;visibilityNeed([bytes writeToFile:statusFile options:0 error:nil],"Inspector page creation");}
  auto environment=fixture::Environment{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation},{"RESHADE_CONTROL_FILE",control}};
  const std::string token(64,'a');if(visibilityOnly)environment.insert(environment.end(),{{"RESHADE_RUNTIME_STATUS_FILE",statusFile.fileSystemRepresentation},{"RESHADE_RUNTIME_STATUS_TOKEN",token.c_str()},{"RESHADE_RUNTIME_STATUS_LAUNCH_ID","visibility"}});
  int status=fixture::runPhase(visibilityOnly?"visibility":"presenter",environment,{temporary,modelArgument});
  if(status==0&&!visibilityOnly)status=fixture::runPhase("legacy",{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT_PLAN",nullptr},{"RESHADE_CONTROL_FILE",control},{"RESHADE_LIVE_EFFECTS",temporary},{"RESHADE_EFFECT_KEY",std::string(64,'a').c_str()}},{temporary,modelArgument});
  [NSFileManager.defaultManager removeItemAtPath:directory error:nil];return status;
 }
 assert(phase.argc==3);argv=phase.argv+1;
 auto directory=[NSString stringWithUTF8String:argv[0]],plan=[directory stringByAppendingPathComponent:@"plan.json"],control=[directory stringByAppendingPathComponent:@"controls.bin"];
 shaderRoot=directory;const auto model=[directory stringByAppendingPathComponent:@"resident-model.dll"];
 [NSApplication sharedApplication];if(phase.name=="visibility")[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
 auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
 auto layer=[EpochLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.displaySyncEnabled=YES;window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(128,96);
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:128 height:96 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto source=[device newTextureWithDescriptor:descriptor];std::array<unsigned char,128*96*4>pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=40;pixels[i+1]=80;pixels[i+2]=120;pixels[i+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,128,96) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:512];
 if(phase.name=="visibility"){publish(plan,@"a",model,.3,.2);int owner=0;macfx::FramePresenter presenter(layer,&owner);visibility(presenter,layer,window,queue,source);[window close];return 0;}
 if(phase.name=="legacy"){
 // Legacy edits have null execution pointers, so epochs must also cover them.
 controls(control,.2,true);macfx::PresenterConfig config;macfx::LsfgConfig generation;generation.modelPath=argv[1];generation.performance=true;generation.flowScale=.5;generation.multiplier=3;config.generation=generation;int legacyOwner=0;macfx::FramePresenter legacy(layer,&legacyOwner,config);uint64_t id=0;ready(legacy,queue,source,id);
 for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];assert(legacy.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);idle(.05);}idle(.12);assert(legacy.snapshot().presentedGenerated>0);
 for(unsigned change=0;change<2;++change){
  auto old=[queue commandBuffer];const auto oldId=++id;assert(legacy.submit(old,source,oldId,CACurrentMediaTime()).encoded);const auto accepted=legacy.snapshot();controls(control,.8,change==0);
  auto blocked=[queue commandBuffer];const auto busy=legacy.submit(blocked,source,id+1,CACurrentMediaTime());assert(!busy.encoded&&busy.busy);commit(old);idle(.16);const auto stale=legacy.snapshot();assert(stale.lastPresentedFrame!=oldId&&stale.presentedGenerated==accepted.presentedGenerated&&stale.presentedReal==accepted.presentedReal&&stale.dropped>accepted.dropped);
  const auto generated=stale.presentedGenerated;for(unsigned warming=0;warming<2;++warming){idle(.06);auto commands=[queue commandBuffer];assert(legacy.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);awaitFrame(legacy,id);assert(legacy.snapshot().presentedGenerated==generated);}
  // Off preserves the actual source's blue byte (40); there is no synthetic
  // test factory supplying a different fallback image.
  idle(.06);auto ready=[queue commandBuffer];assert(legacy.submit(ready,source,++id,CACurrentMediaTime()).encoded);commit(ready);awaitFrame(legacy,id);assert(legacy.snapshot().presentedGenerated>generated&&legacy.snapshot().reason.empty());verifyBlue(layer,queue,change==0?204:40);idle(.1);
 }
 legacy.stop();[window close];std::puts("Legacy presenter epochs: uniforms and toggles reset with monotonic IDs");return 0;
 }
 publish(plan,@"a",model,.3,.2);
 macfx::EffectPlanExecutor identity;auto candidate=[queue commandBuffer];macfx::ShaderFrame frame{candidate,source,source};auto original=generating(identity,frame);assert(original.execution&&original.execution->generator());
 int owner=0;macfx::FramePresenter presenter(layer,&owner);uint64_t id=0;ready(presenter,queue,source,id);
 for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);idle(.05);}idle(.12);assert(presenter.snapshot().presentedGenerated>0);
 auto held=[queue commandBuffer];const auto heldId=++id;assert(presenter.submit(held,source,heldId,CACurrentMediaTime()).encoded);const auto before=presenter.snapshot();
 publish(plan,@"c",model,.3,.8);candidate=[queue commandBuffer];frame.commands=candidate;auto suffix=generating(identity,frame);
 if(!suffix.execution||suffix.execution==original.execution||suffix.execution->generator()!=original.execution->generator())std::fprintf(stderr,"Suffix preparation plan=%s revision=%s hold=%d changed=%d execution=%d same=%d generator=%p original=%p preparing=%d error=%s\n",
  macfx::currentEffectPlan()?macfx::currentEffectPlan()->revision.substr(0,4).c_str():"none",suffix.execution?suffix.execution->revision().substr(0,4).c_str():"none",suffix.holdPrevious,suffix.changed,bool(suffix.execution),suffix.execution==original.execution,suffix.execution?(void*)suffix.execution->generator().get():nullptr,(void*)original.execution->generator().get(),suffix.preparing,suffix.error.c_str());
 assert(suffix.execution&&suffix.execution!=original.execution&&suffix.execution->generator()==original.execution->generator());
 auto probe=[queue commandBuffer];const auto rejected=presenter.submit(probe,source,id+1,CACurrentMediaTime());assert(!rejected.encoded&&rejected.busy);commit(held);idle(.16);
 const auto retired=presenter.snapshot();assert(retired.lastPresentedFrame!=heldId&&retired.presentedGenerated==before.presentedGenerated&&retired.presentedReal==before.presentedReal&&retired.dropped>before.dropped);
 auto fresh=[queue commandBuffer];assert(presenter.submit(fresh,source,++id,CACurrentMediaTime()).encoded);commit(fresh);awaitFrame(presenter,id);verifyBlue(layer,queue,204);assert(presenter.snapshot().presentedGenerated>retired.presentedGenerated&&presenter.snapshot().reason.empty());
 assert([NSFileManager.defaultManager removeItemAtPath:model error:nil]);publish(plan,@"d",model,.6,.8);candidate=[queue commandBuffer];frame.commands=candidate;auto prefix=generating(identity,frame);assert(prefix.execution&&prefix.execution->generator()==suffix.execution->generator()&&prefix.execution->generationInputIdentity()!=suffix.execution->generationInputIdentity());
 const auto beforePrefix=presenter.snapshot().presentedGenerated;
 for(unsigned warming=0;warming<3;++warming){idle(.06);auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,++id,CACurrentMediaTime()).encoded);commit(commands);awaitFrame(presenter,id);if(warming<2)assert(presenter.snapshot().presentedGenerated==beforePrefix);}
 idle(.1);assert(presenter.snapshot().presentedGenerated>beforePrefix&&presenter.snapshot().reason.empty());presenter.stop();
 // An effects-only drawable is already scheduled in the borrowed buffer;
 // adopting a replacement must retire it even when its host commits it late.
 publish(plan,@"e",model,0,.2,false);int directOwner=0;macfx::FramePresenter direct(layer,&directOwner);
 auto late=[queue commandBuffer];assert(direct.submit(late,source,1,CACurrentMediaTime()).encoded);
 publish(plan,@"f",model,0,.8,false);auto current=[queue commandBuffer];assert(direct.submit(current,source,2,CACurrentMediaTime()).encoded);commit(current);awaitFrame(direct,2);verifyBlue(layer,queue,204);const auto shown=direct.snapshot();commit(late);idle(.1);const auto afterLate=direct.snapshot();assert(afterLate.lastPresentedFrame==2&&afterLate.presentedReal==shown.presentedReal&&afterLate.completedReal==shown.completedReal&&afterLate.dropped>shown.dropped);direct.stop();
 [window close];std::puts("Presenter epochs: stale held batches retired, suffix history reused, prefix resident model reused with fresh history after its private alias disappeared");
}}

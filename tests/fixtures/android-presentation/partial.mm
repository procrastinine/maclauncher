#define main previousLifecycleMain
#include "lifecycle.mm"
#undef main
int main(int argc,char**argv){@try{@autoreleasepool {
 EXPECT(argc==3);std::string mode=argv[2];bool fallback=mode=="shader"||mode=="pipeline";
 if(fallback)unsetenv("KLEPTON_FRAME_LIBRARY");else if(mode=="missing")setenv("KLEPTON_FRAME_LIBRARY","/private/tmp/absent-shared-owned-lifecycle.dylib",1);else setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);
 if(mode=="queue")queueFailures=2;if(mode=="event")eventFailures=4;if(mode=="shader")shaderFailures=2;if(mode=="pipeline")pipelineFailures=2;
 JNINativeInterface_ functions{};functions.ExceptionCheck=pending;functions.FindClass=find;functions.ThrowNew=throwNew;JNIEnv env{&functions};
 device=[CPUDevice new];auto layer=[CPULayer new];auto p=(Presenter*)klj_metal_create(&env,(__bridge void*)layer,64,64);EXPECT(p);klj_metal_enter(p);
 int display,configValue;
 for(unsigned attempt=0;attempt<2;++attempt){
  if(attempt)exception="Original caller exception";
  auto surface=klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr);
  if(attempt&&surface){
   EXPECT(p->device&&!p->shared&&!p->displayPipeline&&textureCreates==1);
   EXPECT(destroyPbuffer(surface));EXPECT(klj_metal_detach_surface(&env));klj_metal_enter(nullptr);klj_metal_destroy(p);
   EXPECT(surfaces.empty()&&fences.empty()&&liveQueues==0&&liveEvents==0);
   fprintf(stderr,"PARTIAL_INITIALIZATION_BYPASSED %s: second call allocated a source without usable shared/fallback presentation; %u checks.\n",mode.c_str(),checks);return 19;
  }
  EXPECT(!surface&&pending(&env));if(attempt)EXPECT(exception=="Original caller exception");
  EXPECT(!p->source&&!p->surface&&!p->storage&&textureCreates==0&&surfaces.empty());
  EXPECT(!p->shared&&!p->displayPipeline);EXPECT(liveQueues<=1&&liveEvents<=2);exception.clear();
 }
 if(mode=="missing")setenv("KLEPTON_FRAME_LIBRARY",argv[1],1);
 auto surface=klj_metal_surface(&env,&display,&configValue,64,64,false,nullptr);EXPECT(surface&&!pending(&env));EXPECT(deviceQueries==3);
 EXPECT(fallback?(!p->shared&&p->displayPipeline):(p->shared&&!p->displayPipeline));EXPECT(textureCreates==1);
 EXPECT(destroyPbuffer(surface));EXPECT(klj_metal_detach_surface(&env));klj_metal_enter(nullptr);klj_metal_destroy(p);
 EXPECT(surfaces.empty()&&fences.empty()&&liveQueues==0&&liveEvents==0);device=nil;
 printf("PASS %u actual partial-init %s checks; two rejected calls, original exception preserved, later recovery, bounded resources; CPU only.\n",checks,mode.c_str());return 0;
}}@catch(NSException*error){fprintf(stderr,"FIXTURE_EXCEPTION: %s\n",error.reason.UTF8String);return 20;}}

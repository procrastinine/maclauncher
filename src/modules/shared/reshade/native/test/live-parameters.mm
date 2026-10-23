#include "frame.h"
#include "live-controls.hpp"
#import <Metal/Metal.h>
#include <cstdio>
#include <array>
#include <atomic>
#include <fstream>
#include <stdexcept>
#include <thread>
static void require(bool value,const char*message){if(!value)throw std::runtime_error(message);}
static int controlTokens(){
 char directory[]="/tmp/maclauncher-control-tokens-XXXXXX";require(mkdtemp(directory),"Cannot create controls directory");
 const std::string file=std::string(directory)+"/controls.bin";setenv("RESHADE_CONTROL_FILE",file.c_str(),1);
 macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=2;
 {std::ofstream output(file,std::ios::binary);output.write(reinterpret_cast<const char*>(&packet),sizeof(packet));require(output.good(),"Cannot publish controls");}
 std::array<uint64_t,8>tokens{};std::array<std::thread,8>threads;std::atomic<bool>failed{false};
 for(unsigned i=0;i<threads.size();++i)threads[i]=std::thread([&,i]{
  const auto &first=macfx::refreshLiveState();tokens[i]=first.generation;
  if(!first.controls.get()||!tokens[i]||macfx::refreshLiveState().generation!=tokens[i])failed.store(true);
 });
 for(auto &thread:threads)thread.join();require(!failed.load(),"A reader rejected valid controls or changed an unchanged token");
 for(unsigned i=0;i<tokens.size();++i)for(unsigned j=0;j<i;++j)require(tokens[i]!=tokens[j],"Independent readers aliased an accepted token");
 const auto accepted=macfx::refreshLiveState().generation;require(accepted!=0,"Main reader did not accept controls");
 for(const auto token:tokens)require(token!=accepted,"Main and worker reader tokens aliased");
 try{
  macfx::LiveStatePin pinned;
  packet.flags=8;const std::string next=file+".new";{std::ofstream output(next,std::ios::binary);output.write(reinterpret_cast<const char*>(&packet),sizeof(packet));require(output.good(),"Cannot replace controls");}
  require(rename(next.c_str(),file.c_str())==0,"Cannot replace controls");
  {macfx::LiveStatePin nested;require(macfx::refreshLiveState().generation==accepted,"Nested pin did not keep accepted controls stable");}
  require(macfx::refreshLiveState().generation==accepted,"Inner pin released the outer snapshot");
  throw std::runtime_error("expected pin unwind");
 }catch(const std::runtime_error &error){require(std::string(error.what())=="expected pin unwind","Pinned reader check failed");}
 const auto &replaced=macfx::refreshLiveState();require(replaced.generation!=accepted&&replaced.controls.get()&&replaced.controls.get()->flags==8,"Exception leaked pin or failed to refresh real replacement");
 const auto replacedToken=replaced.generation;require(macfx::refreshLiveState().generation==replacedToken,"Unchanged forced read allocated another accepted token");
 packet.flags=64;const std::string invalid=file+".new";{std::ofstream output(invalid,std::ios::binary);output.write(reinterpret_cast<const char*>(&packet),sizeof(packet));require(output.good(),"Cannot publish invalid replacement");}
 require(rename(invalid.c_str(),file.c_str())==0,"Cannot replace controls");
 const auto &retained=macfx::refreshLiveState();require(retained.generation==replacedToken&&retained.controls.get()&&retained.controls.get()->flags==8,"Invalid forced replacement promoted desired bytes or changed accepted identity");
 require(unlink(file.c_str())==0&&rmdir(directory)==0,"Cannot remove control token files");
 std::puts("Accepted controls: unique stable cross-reader tokens, nested pin and exception restoration; no Metal initialization");return 0;
}
#ifdef MACFX_CONTROL_TOKENS_ONLY
int main(int argc,char**argv){try{
 require(argc==1||(argc==2&&std::string(argv[1])=="--control-tokens"),"Usage: live-control-tokens [--control-tokens]");return controlTokens();
}catch(const std::exception&e){fprintf(stderr,"%s\n",e.what());return 1;}}
#else
int main(int argc,char**argv){@autoreleasepool{try{
 if(argc==2&&std::string(argv[1])=="--control-tokens")return controlTokens();
 require(argc==3,"Usage: live-parameters EFFECT.fx CONTROL_FILE");
 setenv("RESHADE_EFFECT",argv[1],1);setenv("RESHADE_CONTROL_FILE",argv[2],1);
 const std::string key(64,'a');setenv("RESHADE_EFFECT_KEY",key.c_str(),1);
 auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");auto queue=[device newCommandQueue];
 auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:32 height:24 mipmapped:NO];
 desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
 auto source=[device newTextureWithDescriptor:desc],output=[device newTextureWithDescriptor:desc];
 std::array<unsigned char,32*24*4> pixels;for(size_t i=0;i<pixels.size();i+=4){pixels[i]=204;pixels[i+1]=51;pixels[i+2]=102;pixels[i+3]=255;}
 [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
 int owner=0;
 for(unsigned frame=0;frame<4;++frame){
  macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=2;std::memcpy(packet.effectKey,key.data(),64);
  packet.count=frame==3?0:1;std::strcpy(packet.uniforms[0].name,"V__Strength");packet.uniforms[0].count=1;packet.uniforms[0].values[0]=frame==0?0:1;
  const std::string temp=std::string(argv[2])+".tmp";{std::ofstream file(temp,std::ios::binary);file.write(reinterpret_cast<const char*>(&packet),sizeof(packet));}require(rename(temp.c_str(),argv[2])==0,"Cannot publish control packet");
  std::this_thread::sleep_for(std::chrono::milliseconds(110));auto cb=[queue commandBuffer];
  RSFrameRequest request{sizeof(RSFrameRequest),1,&owner,(__bridge void*)cb,(__bridge void*)source,(__bridge void*)output,frame+1,RS_FRAME_BILINEAR,RS_FRAME_PERCEPTUAL,RS_FRAME_TOP_LEFT};RSFrameResult result{};result.size=sizeof(result);result.version=1;
  require(rsProcessFrame(&request,&result)==RS_FRAME_OK,result.reason);require(result.encoded&&result.effects,"Effect was not processed");[cb commit];[cb waitUntilCompleted];require(cb.status==MTLCommandBufferStatusCompleted,"GPU effect failed");
  std::array<unsigned char,32*24*4> actual;[output getBytes:actual.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];
  for(size_t i=0;i<actual.size();i+=4){require(actual[i+3]==255,"Alpha changed");if(frame==0)require(actual[i]==204&&actual[i+1]==51&&actual[i+2]==102,"Zero strength changed source color");else require(abs(int(actual[i])-int(actual[i+1]))<=1&&abs(int(actual[i+1])-int(actual[i+2]))<=1,"Live strength or reset did not produce grayscale");}
  [source getBytes:actual.data() bytesPerRow:128 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];require(actual==pixels,"Source was modified");
 }
 rsReleaseFrameOwner(&owner);unlink(argv[2]);puts("Live Metal parameters: original color, grayscale, repeat, reset, alpha and source preservation passed");return 0;
}catch(const std::exception&e){fprintf(stderr,"%s\n",e.what());return 1;}}}
#endif

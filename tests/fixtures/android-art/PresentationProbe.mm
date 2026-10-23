#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>
#include <cstring>
#include <vector>
#include "bridge.h"
#include "clock/display-clock.h"
struct Output{uint32_t width,height,dpiX,dpiY;uint64_t interval,frame,presentedNanos,completed,screen;};
static void view(NSView*v,int depth=0){fprintf(stderr,"view depth=%d class=%s hidden=%d ancestor=%d frame=%s layer=%s layerHidden=%d bounds=%s\n",depth,object_getClassName(v),v.hidden,v.hiddenOrHasHiddenAncestor,NSStringFromRect(v.frame).UTF8String,object_getClassName(v.layer),v.layer.hidden,NSStringFromRect(v.layer.bounds).UTF8String);for(NSView*child in v.subviews)view(child,depth+1);}
static void check(bool value,const char*message){if(!value){fprintf(stderr,"FAIL %s\n",message);abort();}}
int main(int argc,char**argv){@autoreleasepool{
 if(argc<2)return 2;int a[2],b[2];pipe(a);pipe(b);int readInput=fcntl(a[0],F_DUPFD,10),writeInput=fcntl(a[1],F_DUPFD,10),readControl=fcntl(b[0],F_DUPFD,10),writeControl=fcntl(b[1],F_DUPFD,10);dup2(writeInput,3);dup2(readControl,4);(void)readInput;(void)writeControl;
 void*h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!h){fprintf(stderr,"%s\n",dlerror());return 2;}
 int registration[2];check(pipe(registration)==0,"registration pipe");dup2(registration[0],5);
 const char*browser=getenv("MACLAUNCHER_ART_BROWSER_SOCKET");check(browser&&strlen(browser)<sizeof(sockaddr_un{}.sun_path),"browser socket path");
 int socket=::socket(AF_UNIX,SOCK_STREAM,0);sockaddr_un address{};address.sun_family=AF_UNIX;strcpy(address.sun_path,browser);check(bind(socket,(sockaddr*)&address,sizeof(address))==0,"browser socket bind");
 auto open=(int(*)(Output*,int,int))dlsym(h,"maclauncher_art_compositor_open");auto mode=(int(*)(uint32_t,int,Output*))dlsym(h,"maclauncher_art_compositor_mode");auto poll=(int(*)(KLDisplayTick*,Output*))dlsym(h,"maclauncher_art_compositor_poll");auto submit=(int64_t(*)(uint64_t,uint64_t))dlsym(h,"maclauncher_art_frame");auto close=(void(*)())dlsym(h,"maclauncher_art_compositor_close");
 Output output{};if(open(&output,1,socket))return 3;NSWindow*w=NSApp.windows.firstObject;if(argc>2&&strcmp(argv[2],"regular")==0)[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];[w orderBack:nil];
 if(argc>2&&strcmp(argv[2],"modes")==0){
  check(mode!=nullptr,"native mode entry");Output original{},alternate{};check(!mode(0,0,&original)&&!mode(1,0,&alternate),"query actual native modes");check((original.width>=original.height)!=(alternate.width>=alternate.height),"distinct native orientation extents");
  std::vector<std::pair<void*,size_t>> mappings;auto draw=[&](const Output&size){size_t bytes=(size_t(size.width)*size.height*4+getpagesize()-1)&~(size_t(getpagesize())-1);auto memory=mmap(nullptr,bytes,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);check(memory!=MAP_FAILED,"original rendered buffer");memset(memory,0xff,bytes);KljArtFrame frame{(uint64_t)memory,bytes,size.width,size.height,size.width,1};check(!submit((uintptr_t)&frame,sizeof(frame)),frame.error);mappings.emplace_back(memory,bytes);};
  auto observe=[&](){KLDisplayTick tick{};check(poll(&tick,&output)>=0,"display/input owner poll");};
  draw(original);check(!mode(1,1,&alternate),"native alternate mode selection");observe();check(output.width==original.width&&output.height==original.height,"resize request does not publish unrendered source extent");draw(original);observe();check(output.width==original.width,"old queued buffer cannot commit new mode");
  draw(alternate);observe();check(output.width==alternate.width&&output.height==alternate.height,"matching actual buffer commits display/input extent");
  check(mode(2,1,&output)!=0,"invalid physical mode rejected");check(!mode(0,1,&original),"native original mode selection");draw(original);observe();check(output.width==original.width&&output.height==original.height,"return mode commits matching buffer");
  fcntl(readInput,F_SETFL,fcntl(readInput,F_GETFL)|O_NONBLOCK);struct Input{uint32_t kind;int32_t action,code,meta;float x,y,dx,dy;};Input event{};int changes=0;while(read(readInput,&event,sizeof(event))==sizeof(event))if(event.kind==9){const auto&expected=changes?original:alternate;check(event.action==int(expected.width)&&event.code==int(expected.height)&&event.meta==int(expected.screen),"committed viewport record has exact display identity/extent");changes++;}check(changes==2,"one committed viewport event per completed mode");
  close();for(auto [memory,bytes]:mappings)munmap(memory,bytes);puts("PASS shared physical native modes, original buffers, deferred display/input commit and retirement");return 0;
 }
 const size_t bytes=(size_t(output.width)*output.height*4+getpagesize()-1)&~(size_t(getpagesize())-1);auto pixels=(uint32_t*)mmap(nullptr,bytes,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);for(unsigned y=0;y<output.height;y++)for(unsigned x=0;x<output.width;x++)pixels[y*output.width+x]=0xff0040ffu+(x%128)*256;
 KljArtFrame frame{(uint64_t)pixels,bytes,output.width,output.height,output.width,1};
 for(unsigned i=0;i<60;i++){@autoreleasepool{KLDisplayTick tick{};if(poll(&tick,&output)<0)return 4;if(submit((uintptr_t)&frame,sizeof(frame))){fprintf(stderr,"%s\n",frame.error);return 5;}usleep(16000);}}
 fprintf(stderr,"RESULT frames=%llu presented=%llu output=%llu visible=%d occluded=%d policy=%ld\n",frame.frame,frame.presented,output.frame,w.visible,!(w.occlusionState&NSWindowOcclusionStateVisible),(long)NSApp.activationPolicy);view(w.contentView);close();munmap(pixels,bytes);return 0;
}}

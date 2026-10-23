#include "android-terminal.h"
#include "exports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <termios.h>
#include <unistd.h>
#include <util.h>
#include <sys/ioctl.h>
static void *(*lookup)(const char *);
template<class T>static T function(const char *name){auto pointer=lookup(name);assert(pointer);return reinterpret_cast<T>(pointer);}
int main(int argc,char **argv){
  assert(argc==2);auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
  lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"klj_terminal_lookup"));assert(lookup);
  for(const auto *name:exports)assert(lookup(name));
  auto dispatch=reinterpret_cast<int(*)(int,unsigned long,uintptr_t,int *)>(dlsym(library,"klj_terminal_ioctl_dispatch"));assert(dispatch);
  int master,slave;assert(openpty(&master,&slave,nullptr,nullptr,nullptr)==0);
  std::array<unsigned char,sizeof(klj_android_termios)+32> storage;storage.fill(0xa7);
  auto android=reinterpret_cast<klj_android_termios *>(storage.data()+16);
  auto guards=[&]{for(unsigned i=0;i<16;i++)assert(storage[i]==0xa7&&storage[sizeof(*android)+16+i]==0xa7);};
  auto get=function<int(*)(int,klj_android_termios *)>("tcgetattr");
  auto set=function<int(*)(int,int,const klj_android_termios *)>("tcsetattr");
  assert(sizeof(*android)==36&&sizeof(termios)>sizeof(*android));assert(get(slave,android)==0);guards();
  termios host;assert(tcgetattr(slave,&host)==0);
  assert(bool(android->c_iflag&KLJ_ANDROID_ICRNL)==bool(host.c_iflag&ICRNL));
  assert(bool(android->c_lflag&KLJ_ANDROID_ECHO)==bool(host.c_lflag&ECHO));
  assert(android->c_cc[KLJ_ANDROID_VINTR]==host.c_cc[VINTR]);
  auto speed=function<int(*)(klj_android_termios *,uint32_t)>("cfsetspeed");
  assert(speed(android,KLJ_ANDROID_B9600)==0);
  android->c_iflag|=KLJ_ANDROID_ICRNL|KLJ_ANDROID_IXON;
  android->c_lflag|=KLJ_ANDROID_ECHO|KLJ_ANDROID_ISIG;
  android->c_cc[KLJ_ANDROID_VEOF]=0;android->c_cc[KLJ_ANDROID_VMIN]=0;android->c_cc[KLJ_ANDROID_VTIME]=3;
  assert(set(slave,KLJ_ANDROID_TCSANOW,android)==0);guards();assert(tcgetattr(slave,&host)==0);
  assert(cfgetospeed(&host)==9600&&(host.c_iflag&ICRNL)&&(host.c_iflag&IXON));
  assert(host.c_cc[VEOF]==_POSIX_VDISABLE&&host.c_cc[VMIN]==0&&host.c_cc[VTIME]==3);
  auto raw=function<void(*)(klj_android_termios *)>("cfmakeraw");raw(android);guards();
  assert(!(android->c_iflag&(KLJ_ANDROID_ICRNL|KLJ_ANDROID_IXON))&&!(android->c_lflag&(KLJ_ANDROID_ECHO|KLJ_ANDROID_ISIG)));
  assert(android->c_cc[KLJ_ANDROID_VMIN]==1&&android->c_cc[KLJ_ANDROID_VTIME]==0);
  assert(set(slave,KLJ_ANDROID_TCSANOW,android)==0&&tcgetattr(slave,&host)==0);
  assert(!(host.c_lflag&(ECHO|ISIG))&&host.c_cc[VMIN]==1&&host.c_cc[VTIME]==0);
  int result;assert(dispatch(slave,KLJ_ANDROID_TCGETS,reinterpret_cast<uintptr_t>(android),&result)&&result==0);guards();
  assert((android->c_cflag&KLJ_ANDROID_CBAUD)==KLJ_ANDROID_B9600);
  errno=0;assert(set(slave,99,android)==-1&&errno==EINVAL);guards();
  auto copy=*android;errno=0;assert(get(-1,android)==-1&&errno==EBADF&&!std::memcmp(android,&copy,sizeof(copy)));guards();
  errno=0;assert(speed(android,0x40000000)==-1&&errno==EINVAL);guards();
  klj_android_winsize size{31,97,800,600};
  auto setSize=function<int(*)(int,const klj_android_winsize *)>("tcsetwinsize");auto getSize=function<int(*)(int,klj_android_winsize *)>("tcgetwinsize");
  assert(setSize(slave,&size)==0);std::memset(&size,0,sizeof(size));assert(getSize(slave,&size)==0&&size.ws_row==31&&size.ws_col==97);
  winsize nativeSize;assert(ioctl(slave,TIOCGWINSZ,&nativeSize)==0&&nativeSize.ws_xpixel==800&&nativeSize.ws_ypixel==600);
  auto flow=function<int(*)(int,int)>("tcflow");assert(flow(slave,KLJ_ANDROID_TCOOFF)==0&&flow(slave,KLJ_ANDROID_TCOON)==0);
  auto flush=function<int(*)(int,int)>("tcflush");assert(flush(slave,KLJ_ANDROID_TCIOFLUSH)==0);
  assert(!dispatch(slave,0xffffffff,0,&result));close(slave);close(master);
  std::cout<<"PASS original terminal family, exact Android records, physical flags, control indices, speeds and ioctl routing\n";
}

#import <Foundation/Foundation.h>
#include "presentation.h"
#include "target-time.h"
#include "presentation-observed.h"
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <cstdio>
#include <cstring>
#include <limits.h>
#include <initializer_list>
#include <cstdint>
static unsigned checks;
static unsigned retired,producerReleased;
static void observe(void *context,uint64_t,double,double,uint32_t){if(context==&retired)++retired;}
static void releaseProducer(void *context){if(context==&producerReleased)++producerReleased;}
#define CHECK(x) do{++checks;if(!(x)){fprintf(stderr,"FAIL %d %s\n",__LINE__,#x);return 1;}}while(0)
static bool from(void*p,const char*file){Dl_info i{};char actual[PATH_MAX],expected[PATH_MAX];return p&&dladdr(p,&i)&&realpath(i.dli_fname,actual)&&realpath(file,expected)&&!strcmp(actual,expected);}
int main(int argc,char**argv){@autoreleasepool{
 CHECK(argc==2);void*lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!lib)fprintf(stderr,"%s\n",dlerror());CHECK(lib);
 for(auto n:{"rsCreateFramePresenter","rsSubmitFramePresenter","rsSubmitFramePresenterObserved","rsGetFramePresenterStatus","rsDestroyFramePresenter","rsSubmitFramePresenterAtTime","rsSubmitFramePresenterAtTimeObserved","rsGetFramePresenterTiming","rsProcessFrame","rsReleaseFrameOwner","_ZN5macfx20ownedPresentationKeyE","_ZN5macfx26ownedPresentationBufferKeyE"})CHECK(from(dlsym(lib,n),argv[1]));
 unsigned libraries=0;for(uint32_t i=0;i<_dyld_image_count();i++){const char*n=_dyld_get_image_name(i);CHECK(!strstr(n,"libtimed-presenter"));if(strstr(n,"libreshade-macos.dylib")){CHECK(from(dlsym(lib,"rsProcessFrame"),n));++libraries;}}CHECK(libraries==1);
 auto create=(decltype(&rsCreateFramePresenter))dlsym(lib,"rsCreateFramePresenter");auto old=(decltype(&rsSubmitFramePresenter))dlsym(lib,"rsSubmitFramePresenter");auto target=(decltype(&rsSubmitFramePresenterAtTime))dlsym(lib,"rsSubmitFramePresenterAtTime");auto timing=(decltype(&rsGetFramePresenterTiming))dlsym(lib,"rsGetFramePresenterTiming");auto status=(decltype(&rsGetFramePresenterStatus))dlsym(lib,"rsGetFramePresenterStatus");auto destroy=(decltype(&rsDestroyFramePresenter))dlsym(lib,"rsDestroyFramePresenter");auto frame=(decltype(&rsProcessFrame))dlsym(lib,"rsProcessFrame");
 auto observed=(decltype(&rsSubmitFramePresenterObserved))dlsym(lib,"rsSubmitFramePresenterObserved");auto targetedObserved=(decltype(&rsSubmitFramePresenterAtTimeObserved))dlsym(lib,"rsSubmitFramePresenterAtTimeObserved");
 RSPresenterError error{sizeof(error),1,{}};RSPresenterOptions options{sizeof(options),1,0,0,0};RSPresentationTarget at{sizeof(at),1,1};RSPresentationTiming stats{sizeof(stats),1};RSPresenterStatus s{sizeof(s),1};RSFrameResult result{};result.size=sizeof(result);result.version=1;
 for(unsigned i=0;i<1000;i++){CHECK(!create(nullptr,nullptr,&options,&error));CHECK(old(nullptr,nullptr,&result)==RS_FRAME_INVALID_ARGUMENT);CHECK(target(nullptr,nullptr,&at,&result)==RS_FRAME_INVALID_ARGUMENT);CHECK(target(nullptr,nullptr,nullptr,&result)==RS_FRAME_INVALID_ARGUMENT);CHECK(timing(nullptr,&stats)==RS_FRAME_INVALID_ARGUMENT);CHECK(status(nullptr,&s)==RS_FRAME_INVALID_ARGUMENT);CHECK(frame(nullptr,&result)==RS_FRAME_INVALID_ARGUMENT);destroy(nullptr);}
 // Malformed observers fail before touching an opaque presenter or any
 // Objective-C object. Rejection retains both caller-owned callback contexts.
 RSPresenterSubmission item{};item.size=sizeof(item);item.version=RS_PRESENTER_ABI_VERSION;item.lifetimeToken=&producerReleased;item.releaseToken=releaseProducer;
 RSPresentationObserver observer{sizeof(observer),RS_TARGET_ABI_VERSION,&retired,observe};
 auto sentinel=reinterpret_cast<void*>(uintptr_t(1));
 CHECK(observed(sentinel,&item,nullptr,&result)==RS_FRAME_INVALID_ARGUMENT);
 auto invalid=observer;invalid.size=sizeof(invalid)-1;CHECK(observed(sentinel,&item,&invalid,&result)==RS_FRAME_INVALID_ARGUMENT);
 invalid=observer;invalid.version=RS_TARGET_ABI_VERSION+1;CHECK(observed(sentinel,&item,&invalid,&result)==RS_FRAME_INVALID_ARGUMENT);
 invalid=observer;invalid.retired=nullptr;CHECK(observed(sentinel,&item,&invalid,&result)==RS_FRAME_INVALID_ARGUMENT);
 CHECK(observed(nullptr,&item,&observer,&result)==RS_FRAME_INVALID_ARGUMENT);
 CHECK(observed(sentinel,nullptr,&observer,&result)==RS_FRAME_INVALID_ARGUMENT);
 CHECK(observed(sentinel,&item,&observer,nullptr)==RS_FRAME_INVALID_ARGUMENT);
 auto badResult=result;badResult.version=RS_FRAME_ABI_VERSION+1;CHECK(observed(sentinel,&item,&observer,&badResult)==RS_FRAME_INVALID_ARGUMENT);
 badResult=result;badResult.size=sizeof(badResult)-1;CHECK(observed(sentinel,&item,&observer,&badResult)==RS_FRAME_INVALID_ARGUMENT);
 auto badItem=item;badItem.version=RS_PRESENTER_ABI_VERSION+1;CHECK(observed(sentinel,&badItem,&observer,&result)==RS_FRAME_INVALID_ARGUMENT);
 badItem=item;badItem.size=sizeof(badItem)-1;CHECK(observed(sentinel,&badItem,&observer,&result)==RS_FRAME_INVALID_ARGUMENT);
 CHECK(targetedObserved(sentinel,&item,nullptr,&observer,&result)==RS_FRAME_INVALID_ARGUMENT);
 CHECK(retired==0&&producerReleased==0);
 CHECK(dlclose(lib)==0);printf("PASS %u CPU checks: actual full-library old/new ABI validation, one loaded owner for processing/presentation/keys, no reexport, no GPU or window\n",checks);
}}

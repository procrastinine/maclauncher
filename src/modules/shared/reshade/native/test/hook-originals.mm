#import <Foundation/Foundation.h>
#include "hook-originals.hpp"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>
@interface HookTarget:NSObject @property(nonatomic) int value; -(void)signal; @end
@implementation HookTarget -(void)signal{} @end
@interface HookChild:HookTarget @end
@implementation HookChild @end
@interface HookObserver:NSObject @end
@implementation HookObserver -(void)observeValueForKeyPath:(NSString*)path ofObject:(id)object change:(NSDictionary*)change context:(void*)context{} @end
namespace {
std::string trace;int depth=0;IMP foreignOriginal=nullptr;
macfx::HookOriginals &first(){static auto *value=new macfx::HookOriginals;return *value;}
macfx::HookOriginals &second(){static auto *value=new macfx::HookOriginals;return *value;}
// A cycle stops at a fixed depth so the exact chain assertion reports it.
void forward(macfx::HookOriginals &owner,id self,SEL selector,const char *name){trace+=name;const IMP next=owner.original(self,selector);assert(next);if(++depth<16)reinterpret_cast<void(*)(id,SEL)>(next)(self,selector);--depth;}
void firstHook(id self,SEL selector){forward(first(),self,selector,"first>");}
void secondHook(id self,SEL selector){forward(second(),self,selector,"second>");}
void foreignHook(id self,SEL selector){trace+="foreign>";reinterpret_cast<void(*)(id,SEL)>(foreignOriginal)(self,selector);}
void originalSignal(id,SEL){trace+="original";}
std::string call(id object){trace.clear();[object signal];return trace;}
}
int main(){@autoreleasepool{
    const SEL signal=@selector(signal);method_setImplementation(class_getInstanceMethod(HookTarget.class,signal),(IMP)originalSignal);
    HookTarget *target=[HookTarget new];HookChild *child=[HookChild new];
    // Owners hook one class in turn, then the first owner sees it again for another object.
    first().replace(HookTarget.class,signal,(IMP)firstHook);second().replace(HookTarget.class,signal,(IMP)secondHook);
    first().replace(HookTarget.class,signal,(IMP)firstHook);
    assert(call(target)=="second>first>original"&&call(child)=="second>first>original");
    // A foreign wrapper that chains to the current implementation stays outermost.
    foreignOriginal=method_setImplementation(class_getInstanceMethod(HookTarget.class,signal),(IMP)foreignHook);
    first().replace(HookTarget.class,signal,(IMP)firstHook);second().replace(HookTarget.class,signal,(IMP)secondHook);
    assert(call(target)=="foreign>second>first>original"&&call(child)=="foreign>second>first>original");
    // KVO and later dynamic subclasses resolve the nearest saved implementation.
    HookObserver *observer=[HookObserver new];HookTarget *observed=[HookTarget new];
    [observed addObserver:observer forKeyPath:@"value" options:0 context:nullptr];assert(object_getClass(observed)!=HookTarget.class);
    assert(call(observed)=="foreign>second>first>original");[observed removeObserver:observer forKeyPath:@"value"];
    Class dynamic=objc_allocateClassPair(HookTarget.class,"HookDynamic",0);
    class_addMethod(dynamic,signal,imp_implementationWithBlock(^(id){trace+="dynamic";}),"v@:");objc_registerClassPair(dynamic);
    id instance=[dynamic new];assert(call(instance)=="dynamic");
    first().replace(dynamic,signal,(IMP)firstHook);first().replace(dynamic,signal,(IMP)firstHook);assert(call(instance)=="first>dynamic");
    // Lookups on other threads stay exact while new classes are hooked.
    std::vector<std::thread> readers;std::atomic<bool> failed{false};
    for(int thread=0;thread<4;++thread)readers.emplace_back([&]{for(int i=0;i<20000;++i)if(first().original(target,signal)!=(IMP)originalSignal||second().original(child,signal)!=(IMP)firstHook)failed=true;});
    for(int i=0;i<64;++i){char name[32];std::snprintf(name,sizeof(name),"HookDynamic%d",i);Class cls=objc_allocateClassPair(HookTarget.class,name,0);
        class_addMethod(cls,signal,(IMP)originalSignal,"v@:");objc_registerClassPair(cls);first().replace(cls,signal,(IMP)firstHook);
        assert(first().original([cls new],signal)==(IMP)originalSignal);}
    for(auto &reader:readers)reader.join();assert(!failed);
    std::puts("Hook owners keep their first saved original: repeated, alternating and foreign re-hooks form one finite chain to the original; subclasses, KVO and later dynamic classes resolve exactly");
}}

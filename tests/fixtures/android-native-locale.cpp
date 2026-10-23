#include "android-locale.h"
#include "locale-layout.h"
#include <atomic>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <locale.h>
#include <thread>
#include <xlocale.h>
static klj_android_lconv *(*view)(void);
static void compare(){
    const lconv *native=localeconv();errno=EINTR;
    const klj_android_lconv *android=view();assert(android&&errno==EINTR);
#define CHECK(field) assert(android->field==native->field);
    KLJ_LOCALE_FIELDS(CHECK)
#undef CHECK
}
int main(int argc,char **argv){
    assert(argc==2);auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
    auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"klj_locale_lookup"));assert(lookup);
    view=reinterpret_cast<klj_android_lconv *(*)(void)>(lookup("localeconv"));assert(view&&!lookup("uselocale"));
    locale_t english=newlocale(LC_ALL_MASK,"en_US.UTF-8",nullptr);assert(english);
    locale_t previous=uselocale(english);assert(previous);compare();
    auto first=view();assert(first==view());
    auto native=localeconv();
    // A real monetary locale distinguishes the fields exchanged by Darwin's
    // record ordering, so raw forwarding cannot satisfy this check.
    assert(native->int_p_sep_by_space!=native->int_n_cs_precedes);
    auto wrong=reinterpret_cast<const klj_android_lconv *>(native);
    assert(wrong->int_p_sep_by_space!=first->int_p_sep_by_space);
    std::atomic<bool> ready=false,release=false;klj_android_lconv *other=nullptr;
    std::thread worker([&]{
        auto french=newlocale(LC_ALL_MASK,"fr_FR.UTF-8",nullptr);assert(french);
        auto old=uselocale(french);assert(old);compare();other=view();ready.store(true,std::memory_order_release);
        while(!release.load(std::memory_order_acquire))std::this_thread::yield();
        compare();assert(uselocale(old)==french);freelocale(french);
    });
    while(!ready.load(std::memory_order_acquire))std::this_thread::yield();
    assert(other&&other!=first);assert(uselocale(nullptr)==english);compare();
    release.store(true,std::memory_order_release);worker.join();
    assert(uselocale(previous)==english);freelocale(english);
    std::cout<<"PASS original Android locale layout, every native field, monetary ordering, thread locale and string ownership\n";
}

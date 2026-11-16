#pragma once
// Stack of another thread of this process, for reporting where a stalled thread waits. The thread is suspended only
// while its registers and frame-pointer chain are read with Mach calls, so nothing that takes a lock runs while it is
// stopped; symbols are resolved after it resumes.
#include <mach/mach.h>
#include <dlfcn.h>
#include <pthread.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace macfx {
inline std::vector<uintptr_t> threadReturnAddresses(thread_act_t thread,unsigned limit=40){
    std::vector<uintptr_t> addresses;addresses.reserve(limit+2);
    if(thread==MACH_PORT_NULL||thread==pthread_mach_thread_np(pthread_self()))return addresses;
    if(thread_suspend(thread)!=KERN_SUCCESS)return addresses;
    uintptr_t pc=0,fp=0;
#if defined(__x86_64__)
    x86_thread_state64_t state;mach_msg_type_number_t count=x86_THREAD_STATE64_COUNT;
    if(thread_get_state(thread,x86_THREAD_STATE64,reinterpret_cast<thread_state_t>(&state),&count)==KERN_SUCCESS){pc=state.__rip;fp=state.__rbp;}
#elif defined(__arm64__)
    arm_thread_state64_t state;mach_msg_type_number_t count=ARM_THREAD_STATE64_COUNT;
    if(thread_get_state(thread,ARM_THREAD_STATE64,reinterpret_cast<thread_state_t>(&state),&count)==KERN_SUCCESS){pc=arm_thread_state64_get_pc(state);fp=arm_thread_state64_get_fp(state);}
#endif
    if(pc){
        addresses.push_back(pc);
        for(unsigned i=0;fp&&i<limit;++i){
            uintptr_t frame[2]={0,0};vm_size_t read=0;
            if(vm_read_overwrite(mach_task_self(),fp,sizeof(frame),reinterpret_cast<vm_address_t>(frame),&read)!=KERN_SUCCESS||read!=sizeof(frame)||!frame[1])break;
#if __has_feature(ptrauth_calls)
            frame[1]=reinterpret_cast<uintptr_t>(__builtin_ptrauth_strip(reinterpret_cast<void*>(frame[1]),0));
#endif
            addresses.push_back(frame[1]);
            if(frame[0]<=fp)break;
            fp=frame[0];
        }
    }
    thread_resume(thread);
    return addresses;
}
// The process's first thread, which is its main thread. The caller releases the returned send right.
inline thread_act_t firstProcessThread(){
    thread_act_array_t threads=nullptr;mach_msg_type_number_t count=0;
    if(task_threads(mach_task_self(),&threads,&count)!=KERN_SUCCESS)return MACH_PORT_NULL;
    const thread_act_t first=count?threads[0]:MACH_PORT_NULL;
    for(mach_msg_type_number_t i=1;i<count;++i)mach_port_deallocate(mach_task_self(),threads[i]);
    vm_deallocate(mach_task_self(),reinterpret_cast<vm_address_t>(threads),count*sizeof(*threads));
    return first;
}
inline std::string describeThreadStack(thread_act_t thread,unsigned limit=40){
    const auto addresses=threadReturnAddresses(thread,limit);
    if(addresses.empty())return "unavailable";
    std::string text;
    for(const auto address:addresses){
        if(!text.empty())text+=" < ";
        Dl_info info{};
        if(dladdr(reinterpret_cast<const void*>(address),&info)&&info.dli_fname){
            const char *image=std::strrchr(info.dli_fname,'/');text+=image?image+1:info.dli_fname;text+=':';
            if(info.dli_sname){text+=info.dli_sname;text+='+'+std::to_string(address-reinterpret_cast<uintptr_t>(info.dli_saddr));}
            // The image offset symbolizes internal functions offline (atos -l 0).
            char offset[24];std::snprintf(offset,sizeof offset,"@0x%llx",static_cast<unsigned long long>(address-reinterpret_cast<uintptr_t>(info.dli_fbase)));text+=offset;
        }else{char value[24];std::snprintf(value,sizeof value,"0x%llx",static_cast<unsigned long long>(address));text+=value;}
    }
    return text;
}
}
namespace macfx {
inline std::string describeMainThreadStack(unsigned limit=40){
    const thread_act_t main=firstProcessThread();if(main==MACH_PORT_NULL)return "unavailable";
    auto text=describeThreadStack(main,limit);mach_port_deallocate(mach_task_self(),main);return text;
}
}

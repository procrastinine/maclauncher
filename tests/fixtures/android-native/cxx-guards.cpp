#include <atomic>
#include <cassert>
#include <cstdint>
#include <thread>
#include <vector>
#include <cstdio>
#include "native-cxx-imports.h"
int main() {
    auto acquire=(int(*)(uint64_t*))klj_native_cxx_lookup("__cxa_guard_acquire");
    auto release=(void(*)(uint64_t*))klj_native_cxx_lookup("__cxa_guard_release");
    auto abortGuard=(void(*)(uint64_t*))klj_native_cxx_lookup("__cxa_guard_abort");
    assert(acquire&&release&&abortGuard);
    struct {uint64_t before=0xabcdef,guard=0,after=0xfedcba;} state;
    std::atomic<int> starts=0;
    int published=0;
    std::vector<std::thread> threads;
    for(int i=0;i<32;i++)threads.emplace_back([&]{
        if(acquire(&state.guard)){starts++;published=12345;release(&state.guard);}
        assert(published==12345);
    });
    for(auto& thread:threads)thread.join();
    assert(starts==1&&state.before==0xabcdef&&state.after==0xfedcba);
    uint64_t retry=0;assert(acquire(&retry)==1);abortGuard(&retry);
    assert(acquire(&retry)==1);release(&retry);assert(acquire(&retry)==0);
    assert(!klj_native_cxx_lookup("__cxa_not_a_guard"));
    puts("PASS native C++ guard synchronization, publication and retry");
}

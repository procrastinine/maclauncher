#include "arm32.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <mach/mach.h>

extern "C" void klj_android_log_initialize(void);
extern "C" kern_return_t catch_mach_exception_raise_state(mach_port_t,exception_type_t,
    const mach_exception_data_t,mach_msg_type_number_t,int*,const thread_state_t,
    mach_msg_type_number_t,thread_state_t,mach_msg_type_number_t*);

int main() {
    using namespace maclauncher::arm32;
    puts("delivered: initialize CPU");fflush(stdout);
    Memory memory;Thread thread(memory);
    puts("delivered: retain physical logger");fflush(stdout);
    klj_android_log_initialize();assert(!fclose(stderr));
    puts("delivered: guest stderr closed");fflush(stdout);
    arm_thread_state64_t state{},result{};
    state.__pc=0x12340000;state.__lr=0x12340008;state.__sp=0x22340000;
    mach_exception_data_type_t code[]={KERN_INVALID_ADDRESS,0x23450000};
    int flavor=ARM_THREAD_STATE64;mach_msg_type_number_t count=ARM_THREAD_STATE64_COUNT;
    errno=EDOM;
    kern_return_t reply;
    try {
        reply=catch_mach_exception_raise_state(0,EXC_BAD_ACCESS,code,2,&flavor,
            reinterpret_cast<thread_state_t>(&state),ARM_THREAD_STATE64_COUNT,
            reinterpret_cast<thread_state_t>(&result),&count);
    } catch(const std::exception& error) {
        printf("delivered: unexpected exception=%s\n",error.what());fflush(stdout);return 1;
    }
    const int retained=errno;
    printf("delivered: reply=%d errno=%d unchanged=%d\n",reply,retained,!memcmp(&state,&result,sizeof state));fflush(stdout);
    assert(reply==KERN_FAILURE&&retained==EDOM&&!memcmp(&state,&result,sizeof state));
    const auto address=memory.allocate(0x30000000,4096,Memory::Read|Memory::Write|Memory::Execute);
    const uint32_t instructions[]={0xe3a0002f,0xe12fff1e};
    std::memcpy(memory.translate(address,sizeof instructions,Memory::Write),instructions,sizeof instructions);
    assert(thread.call(address,{})==47);
    flavor=-1;errno=EDOM;
    assert(catch_mach_exception_raise_state(0,EXC_BAD_ACCESS,code,2,&flavor,
        reinterpret_cast<thread_state_t>(&state),ARM_THREAD_STATE64_COUNT,
        reinterpret_cast<thread_state_t>(&result),&count)==KERN_INVALID_ARGUMENT&&errno==EDOM);
    puts("PASS delivered Mach reporter and original ARM32 execution survive closed stderr");
}

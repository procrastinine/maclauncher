#include "flat-binary.h"
#include "signal-context.h"
#include <atomic>
#include <array>
#include <bit>
#include <chrono>
#include <iostream>
#include <thread>
using namespace maclauncher::arm32;
int main(int argc,char **argv){
    assert(argc==2);Memory memory;Thread thread(memory);FlatBinary binary(memory,argv[1]);
    std::atomic<bool> running=false;
    binary.gate(0,thread.import([&](Thread&){running.store(true,std::memory_order_release);return 0;}));
    const auto output=memory.allocate(0x60000000,4096,Memory::Read|Memory::Write);
    unsigned delivered=0;
    thread.setInterruptHandler([&](Thread &current,Thread::Registers &state){
        ++delivered;assert(&current==&thread);assert(state.general[4]==7);
        assert(state.general[5]>0);assert((state.cpsr&0x1f)==0x10);
        auto previous=state;
        const std::array arguments{Value::word(3)};
        assert(uint32_t(current.call(binary.entry(ENTRY_nested),arguments))==4);
        assert(state.general==previous.general&&state.vector==previous.vector);
        state.general[0]=19;state.general[4]=23;state.general[6]=output;
        state.general[15]=binary.entry(ENTRY_resumed);
        state.vector[0]=std::bit_cast<uint32_t>(42.5f);state.vector[63]=0x12345678;
        state.cpsr=(state.cpsr&~0xf0000000u)|0x20000000u;
        state.fpscr=0x00800000;
    });
    std::thread requester([&]{
        while(!running.load(std::memory_order_acquire))std::this_thread::yield();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        thread.requestInterrupt();
    });
    auto result=thread.call(binary.entry(ENTRY_interrupted));requester.join();
    assert(delivered==1&&uint32_t(result)==43);
    auto *values=static_cast<const uint32_t *>(memory.translate(output,16,Memory::Read));
    assert(values[0]==43&&values[1]==std::bit_cast<uint32_t>(42.5f));
    assert(values[2]==0x00800000&&values[3]==0x12345678);
    thread.setInterruptHandler({});
    unsigned faults=0;
    thread.setFaultHandler([&](Thread &current,Thread::Registers &state,const Thread::Fault &fault){
        ++faults;assert(&current==&thread);
        if(fault.kind==Thread::Fault::MemoryAccess){
            if(fault.address!=0x62000000||state.general[15]!=binary.entry(ENTRY_faulting))std::cerr<<"fault address="<<std::hex<<fault.address<<" pc="<<state.general[15]<<" expected="<<binary.entry(ENTRY_faulting)<<" count="<<faults<<"\n";
            assert(fault.address==0x62000000&&state.general[15]==binary.entry(ENTRY_faulting));
            if(!fault.protection)memory.map(fault.address,4096,Memory::Read|Memory::Write);
            else memory.protect(fault.address,4096,Memory::Read|Memory::Write);
            *static_cast<uint32_t *>(memory.translate(fault.address,4,Memory::Write))=77;
        }else{
            assert(fault.address==binary.entry(fault.kind==Thread::Fault::Breakpoint?ENTRY_breakpoint:ENTRY_undefined));
            state.general[15]=binary.entry(ENTRY_nested);
        }
        return true;
    });
    const std::array pointer{Value::word(0x62000000)};
    assert(uint32_t(thread.call(binary.entry(ENTRY_faulting),pointer))==77);
    memory.protect(0x62000000,4096,0);
    assert(uint32_t(thread.call(binary.entry(ENTRY_faulting),pointer))==77);
    const std::array number{Value::word(7)};
    assert(uint32_t(thread.call(binary.entry(ENTRY_undefined),number))==8);
    assert(uint32_t(thread.call(binary.entry(ENTRY_breakpoint),number))==8&&faults==4);
    thread.setFaultHandler({});
    JavaVM *vm=nullptr;JNIEnv *env=nullptr;
    char headless[]="-Djava.awt.headless=true",checked[]="-Xcheck:jni";
    JavaVMOption options[]={{headless,nullptr},{checked,nullptr}};JavaVMInitArgs init{};
    init.version=JNI_VERSION_1_8;init.nOptions=2;init.options=options;
    assert(JNI_CreateJavaVM(&vm,reinterpret_cast<void **>(&env),&init)==JNI_OK);
    {
        Jni jni(memory,vm);
        const auto alternate=memory.allocate(0x63000000,16384,Memory::Read|Memory::Write);
        Thread::Registers state{};state.cpsr=0x10;state.general[6]=output;
        state.general[13]=thread.stackTop()-32;state.general[15]=binary.entry(ENTRY_resumed);
        state.vector[63]=123;state.fpscr=0x00800000;
        klj_signal_info info{.signal=40,.code=-1};info.data.sender.value=0x1234;
        klj_signal_context64 frame{};frame.stack={alternate,0,0,16384};frame.mask=2;
        assert(!deliverSignal(jni,thread,state,binary.entry(ENTRY_signal_handler),0x08000004,info,frame));
        assert(state.general[0]==99&&state.general[15]==binary.entry(ENTRY_resumed));
        assert(state.vector[63]==171&&state.fpscr==0x00400000);
        assert(frame.mask==(UINT64_C(64)<<32|2));
        auto *observed=static_cast<const uint32_t *>(memory.translate(output,32,Memory::Read));
        assert(observed[4]==40&&observed[7]==40);
        assert(observed[5]>=alternate&&observed[5]<alternate+16384);
        assert(observed[6]>=alternate&&observed[6]<observed[5]);
        assert(!env->ExceptionCheck());
    }
    assert(vm->DestroyJavaVM()==JNI_OK);
    std::cout<<"PASS translated interrupt, nested execution and GPR/CPSR/FP return state\n";
    std::cout<<"PASS stopped memory protection, missing mapping, undefined instruction and breakpoint recovery\n";
    std::cout<<"PASS original ARM32 signal frame, alternate stack and handler writeback\n";
}

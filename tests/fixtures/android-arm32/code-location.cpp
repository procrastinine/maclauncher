#ifdef CODE_LOCATION_DRIVER
#include <dlfcn.h>
#include <cstdio>
int main(int argc,char **argv){
    if(argc!=2)return 2;
    void *image=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!image){std::fprintf(stderr,"%s\n",dlerror());return 3;}
    auto run=reinterpret_cast<int(*)()>(dlsym(image,"run_code_location_fixture"));
    const int result=run?run():4;dlclose(image);return result;
}
#else
#include "code-location.h"
#include "dynarmic/backend/arm64/a32_address_space.h"
#include "dynarmic/frontend/A32/a32_location_descriptor.h"
#include "A32/testenv.h"
extern "C" {
#include "native-sampling.h"
}
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <future>
#include <memory>
#include <stdexcept>
#include <thread>

static void require(bool condition,const char *message){if(!condition)throw std::runtime_error(message);}
extern "C" __attribute__((visibility("default"))) int run_code_location_fixture(){
    try{
        ArmTestEnv callbacks;
        Dynarmic::A32::UserConfig config;config.callbacks=&callbacks;
        config.code_cache_size=2*1024*1024;
        auto owner=std::make_unique<Dynarmic::Backend::Arm64::A32AddressSpace>(config);
        const Dynarmic::A32::LocationDescriptor descriptor(0x4000,{},{});
        auto entry=owner->GetOrEmit(descriptor);
        const auto pc=reinterpret_cast<uint64_t>(entry);
        KljArm32CodeLocation result{};
        require(maclauncher_arm32_code_location(pc+4,&result)==1,"original block missing");
        require(result.entry==pc&&result.descriptor==descriptor.UniqueHash()&&result.size>4,"original block identity changed");
        const uint64_t base=result.cacheBegin;
        require(maclauncher_arm32_code_location(base,&result)==3,"prelude misattributed");
        require(maclauncher_arm32_code_location(0x1234,&result)==0,"unowned address misattributed");
        size_t length=0;const uint64_t addresses[]={pc+4,base,0x1234};
        char *json=test_native_addresses(addresses,3,nullptr,nullptr,&length);
        require(json&&length&&std::strstr(json,"\"guestBlockPc\":\"0x4000\"")&&std::strstr(json,"\"hostOffset\":4"),"RTLD_LOCAL original block missing from sampler");
        require(std::strstr(json,"prelude-or-no-current-block"),"sampler prelude status missing");
        std::printf("SAMPLE %s\n",json);std::free(json);
        std::future<int> query;bool ready=false;
        {
            KljArm32CodeMetadataScope writing(base);
            query=std::async(std::launch::async,[&]{KljArm32CodeLocation observed{};return maclauncher_arm32_code_location(pc,&observed);});
            ready=query.wait_for(std::chrono::milliseconds(100))==std::future_status::ready;
            owner->ClearCache(); // The original Emit path can enter a nested clear.
        }
        require(ready,"query waited on metadata writer");
        require(query.get()==2,"busy metadata was presented as a block");
        require(maclauncher_arm32_code_location(pc,&result)==3,"cleared block retained stale attribution");
        owner->GetOrEmit(descriptor);
        std::atomic<bool> done{false};std::atomic<unsigned> queries{0};
        std::thread sampler([&]{while(!done){KljArm32CodeLocation observed{};int status=maclauncher_arm32_code_location(pc,&observed);if(status==1&&observed.descriptor!=descriptor.UniqueHash())std::abort();queries++;}});
        for(int i=0;i<200;i++){owner->ClearCache();owner->GetOrEmit(descriptor);}
        done=true;sampler.join();require(queries>0,"concurrent query did not run");
        owner.reset();
        require(maclauncher_arm32_code_location(pc,&result)==0,"retired owner retained attribution");
        std::printf("PASS original block mapping, RTLD_LOCAL sampling, busy fallback, nested clear, %u concurrent queries and owner retirement\n",queries.load());
        return 0;
    }catch(const std::exception &error){std::fprintf(stderr,"FAIL %s\n",error.what());return 1;}
}
#endif

#include "browser-frame-policy.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <limits>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <atomic>
#include <thread>
static void channelMapping(){
    char directory[1024];temporaryPath(directory,"maclauncher-browser-channel-XXXXXX");assert(mkdtemp(directory));
    const std::string file=std::string(directory)+"/channel",link=std::string(directory)+"/link";
    const char *token="00112233445566778899aabbccddeeff";
    unsigned char bytes[64]{};memcpy(bytes,"MLBRSRC1",8);for(unsigned i=0;i<16;++i)bytes[i+8]=i*17;
    const int fd=open(file.c_str(),O_RDWR|O_CREAT|O_EXCL,0600);assert(fd>=0);assert(write(fd,bytes,sizeof(bytes))==sizeof(bytes));
    auto mapped=macfx::mapBrowserFrameChannel(file.c_str(),token);assert(mapped.mapping&&mapped.error==0);
    auto rejected=macfx::mapBrowserFrameChannel(file.c_str(),"10112233445566778899aabbccddeeff");assert(!rejected.mapping&&!strcmp(rejected.stage,"authentication"));
    rejected=macfx::mapBrowserFrameChannel(file.c_str(),"00112233445566778899aabbccddee+f");assert(!rejected.mapping&&!strcmp(rejected.stage,"token"));
    assert(chmod(file.c_str(),0644)==0);rejected=macfx::mapBrowserFrameChannel(file.c_str(),token);assert(!rejected.mapping&&!strcmp(rejected.stage,"metadata"));
    assert(chmod(file.c_str(),0600)==0);assert(ftruncate(fd,63)==0);
    rejected=macfx::mapBrowserFrameChannel(file.c_str(),token);assert(!rejected.mapping&&!strcmp(rejected.stage,"metadata"));
    assert(ftruncate(fd,64)==0);assert(symlink(file.c_str(),link.c_str())==0);
    rejected=macfx::mapBrowserFrameChannel(link.c_str(),token);assert(!rejected.mapping&&!strcmp(rejected.stage,"open")&&rejected.error);
    assert(unlink(link.c_str())==0);assert(unlink(file.c_str())==0);
    // Existing mappings remain shared/readable after future path access fails.
    auto *words=static_cast<uint32_t*>(mapped.mapping);words[9]=20176;
    uint32_t value=0;assert(pread(fd,&value,sizeof(value),36)==sizeof(value)&&value==20176);
    rejected=macfx::mapBrowserFrameChannel(file.c_str(),token);assert(!rejected.mapping&&!strcmp(rejected.stage,"open")&&rejected.error==ENOENT);
    assert(munmap(mapped.mapping,64)==0);close(fd);assert(rmdir(directory)==0);
    assert(!macfx::mapBrowserFrameChannel(nullptr,nullptr).mapping);
    std::puts("browser channel: authenticated map, strict rejection and post-open path loss passed");
}
static void channelDemand(){
    uint32_t words[16]{};macfx::BrowserFrameChannelState main{words},helper{words};
    assert(main.processingAllowed()); // No authoritative publisher before local-window selection.
    assert(main.demand(0,true,101));assert(!main.demand().window&&!helper.processingAllowed());
    helper.observe(11,true);assert(!main.eligible(11)&&!main.window());
    assert(main.demand(11,true,101));const auto first=main.demand();assert(first.window==11&&first.epoch&&first.publisher==101&&helper.processingAllowed());
    // A helper whose live-controls cache is still Off cannot erase parent On.
    assert(!helper.demand(0,false,202));assert(main.demand().window==11);
    assert(!helper.probe(12,first.epoch));assert(!helper.probe(11,first.epoch+1));assert(!main.eligible(11));
    const uint32_t contexts[]={42,56};
    assert(macfx::browserFrameRegistrationMatches(first,11,101,contexts,2,42));
    assert(!macfx::browserFrameRegistrationMatches(first,12,101,contexts,2,42));
    assert(!macfx::browserFrameRegistrationMatches(first,11,202,contexts,2,42));
    assert(!macfx::browserFrameRegistrationMatches(first,11,101,contexts,2,43));
    assert(helper.probe(11,first.epoch)&&main.eligible(11)); // Zero setters after On.
    assert(!helper.claim(11,202));const auto oldClaim=main.claim(11,101);assert(oldClaim&&main.window()==11);
    assert(!main.claim(11,101)); // Capture preparation already excludes native processing.
    helper.observe(11,true); // A source deliberately bypassed under the claim is not native-processing proof.
    main.release(11,oldClaim+2,101);assert(main.owns(11,oldClaim));
    assert(main.demand(0,true,101));assert(!main.window()&&!main.eligible(11)&&!helper.processingAllowed());
    assert(!helper.probe(11,first.epoch));
    assert(main.demand(11,true,101));const auto replacement=main.demand();assert(replacement.epoch!=first.epoch&&!main.eligible(11));
    assert(helper.probe(11,replacement.epoch));const auto newClaim=main.claim(11,101);assert(newClaim&&newClaim!=oldClaim);
    main.release(11,oldClaim,101);assert(main.owns(11,newClaim)); // Late old startup failure cannot release replacement.
    main.release(11,newClaim,202);assert(main.owns(11,newClaim));
    main.release(11,newClaim,101);assert(!main.window());
    assert(main.demand(0,true,101)&&main.demand(11,true,101));helper.observe(11,true);
    assert(!main.eligible(11)&&!main.claim(11,101)); // Fresh full-native source keeps priority.
    assert(main.demand(0,true,101)&&main.demand(11,true,101));
    words[15]=1;helper.observe(11,true);words[15]=0;
    assert(!main.eligible(11)); // Native evidence survives a busy metadata lock.
    words[15]=1;assert(!main.demand(0,true,101));words[15]=0;assert(main.demand().window==11); // Never block on helper metadata.
    assert(main.demand(0,true,101));assert(!main.window()&&!main.demand().window);
    std::puts("browser demand: authoritative On with helper Off, authenticated registration, zero-setter recovery, native priority, Off reset and stale-claim release passed");
}
static void channelAdmissionRace(){
    uint32_t words[16]{};macfx::BrowserFrameChannelState main{words},helper{words};
    assert(main.demand(11,true,101));
    words[6]=1;assert(helper.window()==11);words[6]=0; // Publication in flight conservatively bypasses native.
    std::atomic<unsigned>start{0},done{0};std::atomic<bool>nativeAllowed{false};
    constexpr unsigned rounds=10000;
    std::thread native([&]{for(unsigned i=1;i<=rounds;++i){
        while(start.load(std::memory_order_acquire)<i)std::this_thread::yield();
        helper.observe(11,true);nativeAllowed.store(helper.window()!=11,std::memory_order_relaxed);
        done.store(i,std::memory_order_release);
    }});
    for(unsigned i=1;i<=rounds;++i){
        assert(main.demand(0,true,101)&&main.demand(11,true,101));const auto epoch=main.demand().epoch;
        assert(helper.probe(11,epoch));start.store(i,std::memory_order_release);
        const auto ticket=main.claim(11,101);
        while(done.load(std::memory_order_acquire)<i)std::this_thread::yield();
        assert(!(ticket&&nativeAllowed.load(std::memory_order_relaxed)));
        if(ticket)main.release(11,ticket,101);
    }
    native.join();assert(main.demand(0,true,101));
    std::puts("browser admission: 10000 native/fallback claim races never admitted both paths");
}
int main(){
    macfx::BrowserFrameAttemptContract attempted{7,11};
    assert(!(attempted!=macfx::BrowserFrameAttemptContract{7,11}));
    assert((attempted!=macfx::BrowserFrameAttemptContract{8,11}));
    assert((attempted!=macfx::BrowserFrameAttemptContract{7,12}));
    channelMapping();
    channelDemand();
    channelAdmissionRace();
    macfx::BrowserFrameAdmission admission;
    assert(!admission.fallback(11));
    admission.observe(11,false);admission.probe(11);assert(!admission.fallback(11)); // Off is inert.
    admission.select(11);
    admission.observe(11,false);admission.observe(11,false);assert(!admission.fallback(11));
    admission.observe(11,false);assert(admission.fallback(11));assert(!admission.fallback(12));
    admission.observe(11,true);assert(!admission.fallback(11));
    admission.select(12);admission.observe(12,false);admission.observe(12,false);admission.observe(12,false);assert(admission.fallback(12));
    admission.select(0);admission.select(12);assert(!admission.fallback(12)); // Prior On evidence is not inherited.
    admission.probe(11);assert(!admission.fallback(12)); // Wrong selected source cannot admit capture.
    admission.probe(12);assert(admission.fallback(12)); // Live On with no new setter, but authenticated registration.
    admission.observe(12,true);assert(!admission.fallback(12)); // Fresh full-native source retains priority.
    admission.select(0);admission.probe(12);admission.observe(12,false);assert(!admission.fallback(12));
    assert(!macfx::browserFrameTimeAccepted(1,1));assert(!macfx::browserFrameTimeAccepted(0,0));
    assert(!macfx::browserFrameTimeAccepted(std::numeric_limits<double>::quiet_NaN(),1));
    assert(macfx::browserFrameTimeAccepted(1.0001,1)); // No 30/60/240 Hz clamp.
    assert(!macfx::browserFrameCanReveal(false,2,2,1,0,2,101,101));
    assert(!macfx::browserFrameCanReveal(true,2,1,1,0,2,101,101)); // Old extent/generation completion.
    assert(!macfx::browserFrameCanReveal(true,2,2,1,1,2,101,101)); // Completion predates resize.
    assert(!macfx::browserFrameCanReveal(true,2,2,2,1,1,100,101)); // Accepted source is still generation A.
    assert(!macfx::browserFrameCanReveal(true,2,2,2,1,2,0,101)); // No accepted frame for B yet.
    // Same-size A→B: B's producer completion plus late final A cannot reveal B.
    assert(!macfx::browserFrameCanReveal(true,2,2,2,1,2,101,100));
    assert(macfx::browserFrameCanReveal(true,2,2,3,1,2,101,101));
    assert(macfx::browserFrameCanReveal(true,2,2,4,1,2,101,102));
    assert(macfx::browserFrameGeometryValid({0,28,800,600,1600,1200}));
    assert(!macfx::browserFrameGeometryValid({-1,0,800,600,1600,1200}));
    assert(!macfx::browserFrameGeometryValid({0,0,800,600,0,1200}));
}

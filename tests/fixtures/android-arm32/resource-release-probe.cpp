#include "native-imports.h"
#include "resource-shapes.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstddef>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <sys/mman.h>
#include <unistd.h>
using namespace maclauncher::arm32;

static Memory *memory;
static Imports *imports;
static void *(*sharedLookup)(const char *);
static std::array<unsigned char,128> firstAllocation{},secondAllocation{};
static unsigned char *alignmentAllocation;
static bool alignmentAllocationMode=false;
alignas(16384) static std::array<unsigned char,16384> resolver{};
static std::array<unsigned char,resource_shapes::addressBytes+16> addressBytes{};
static char canonical[]="original-owner.example";
static std::array<uint32_t,6> resolverAliases{};
static std::array<uint32_t,3> allocationAliases{};
static uint32_t reusedAllocation;
static bool reuseOnFree=false,failRealloc=false,resolverReleased=false;
static bool assetReleased=false;
static bool reuseResolverAllocation=false;
static int expectedInputError=-1;

static void retired(uint32_t address){
    assert(address);bool absent=false;
    try{memory->translate(address,1,Memory::Read);}catch(const Memory::Fault &){absent=true;}
    assert(absent&&"All aliases retire before the original resource owner releases storage");
}
static void *allocate(size_t bytes){
    if(alignmentAllocationMode){assert(bytes==8);return alignmentAllocation;}
    if(reuseResolverAllocation){
        reuseResolverAllocation=false;assert(bytes<=resolver.size());
        // A native owner released this typed resource internally. The new
        // allocation must retire its old view before any post-call refresh.
        assert(mprotect(resolver.data(),resolver.size(),PROT_NONE)==0);
        return resolver.data();
    }
    assert(bytes<=firstAllocation.size());return firstAllocation.data();
}
static void *assetOpen(void *,const char *,int){return firstAllocation.data();}
static void assetClose(void *asset){assert(asset==firstAllocation.data());assetReleased=true;}
static size_t capacity(const void *pointer){
    if(pointer==alignmentAllocation)return 8;
    if(pointer==firstAllocation.data()||pointer==secondAllocation.data())return firstAllocation.size();
    if(pointer==resolver.data())return resolver.size();
    return 0;
}
static void release(void *pointer){
    if(pointer==alignmentAllocation)return;
    if(expectedInputError>=0)assert(errno==expectedInputError);
    assert(pointer==firstAllocation.data()||pointer==secondAllocation.data());
    for(auto alias:allocationAliases)if(alias)retired(alias);
    assert(!memory->addressOf(pointer));
    // A native allocator can publish another allocation at the freed address
    // before the releasing call returns. This reentrant use is deterministic.
    if(reuseOnFree){
        reuseOnFree=false;Thread nested(*memory);
        std::array<Value,1> args{Value::word(64)};
        reusedAllocation=uint32_t(nested.call(imports->resolve("malloc"),args));
        assert(reusedAllocation&&memory->translate(reusedAllocation,128,Memory::Write)==firstAllocation.data());
    }
    errno=EBUSY;
}
static void *resize(void *pointer,size_t bytes){
    if(expectedInputError>=0)assert(errno==expectedInputError);
    assert(pointer==firstAllocation.data()&&bytes==96);
    if(failRealloc){errno=ENOMEM;return nullptr;}
    std::memcpy(secondAllocation.data(),firstAllocation.data(),firstAllocation.size());errno=EAGAIN;
    return secondAllocation.data();
}
static void nativePointer(size_t offset,const void *pointer){std::memcpy(resolver.data()+offset,&pointer,sizeof pointer);}
static int resolve(const char *,const char *,const void *,void **output){
    resolver.fill(0);nativePointer(resource_shapes::nextHost,resolver.data());
    nativePointer(resource_shapes::canonicalHost,canonical);nativePointer(resource_shapes::addressHost,addressBytes.data());
    unsigned length=28;std::memcpy(resolver.data()+resource_shapes::lengthHost,&length,sizeof length);
    *output=resolver.data();return 0;
}
static void releaseResolver(void *pointer){
    assert(pointer==resolver.data());for(auto alias:resolverAliases)retired(alias);
    resolverReleased=true;resolver.fill(0xa5);errno=EINTR;
}
static void *lookup(const char *name){
    if(!std::strcmp(name,"malloc"))return reinterpret_cast<void *>(allocate);
    if(!std::strcmp(name,"malloc_usable_size"))return reinterpret_cast<void *>(capacity);
    if(!std::strcmp(name,"free"))return reinterpret_cast<void *>(release);
    if(!std::strcmp(name,"realloc"))return reinterpret_cast<void *>(resize);
    if(!std::strcmp(name,"getaddrinfo"))return reinterpret_cast<void *>(resolve);
    if(!std::strcmp(name,"freeaddrinfo"))return reinterpret_cast<void *>(releaseResolver);
    if(!std::strcmp(name,"AAssetManager_open"))return reinterpret_cast<void *>(assetOpen);
    if(!std::strcmp(name,"AAsset_close"))return reinterpret_cast<void *>(assetClose);
    return sharedLookup(name);
}
static uint32_t guestPointer(uint32_t base,unsigned offset){uint32_t value=0;std::memcpy(&value,memory->translate(base+offset,4,Memory::Read),4);return value;}
int main(int argc,char **argv){
    assert(argc==2);void *native=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!native){std::cerr<<dlerror()<<'\n';return 1;}
    sharedLookup=reinterpret_cast<void *(*)(const char *)>(dlsym(native,"kl_shim_lookup"));assert(sharedLookup);
    Memory ownedMemory;memory=&ownedMemory;Imports ownedImports(*memory,lookup);imports=&ownedImports;Thread thread(*memory);
    imports->setThreadFactory([&]{return std::make_shared<Thread>(*memory);});
    auto call=[&](const char *name,std::initializer_list<Value> args){auto gate=imports->resolve(name);assert(gate);if(expectedInputError>=0)errno=expectedInputError;return thread.call(gate,std::span(args.begin(),args.size()));};
    // Original Scudo reports the request, while native CPU accesses can reach
    // the remainder of its fundamental alignment unit on the same mapped page.
    const auto page=size_t(sysconf(_SC_PAGESIZE));
    auto guarded=static_cast<unsigned char *>(mmap(nullptr,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0));assert(guarded!=MAP_FAILED);
    assert(mprotect(guarded+page,page,PROT_NONE)==0);
    alignmentAllocation=guarded+page-resource_shapes::allocationAlignment;
    alignmentAllocationMode=true;std::memset(alignmentAllocation,0x5a,resource_shapes::allocationAlignment);
    const auto aligned=uint32_t(call("malloc",{Value::word(8)}));
    assert(call("malloc_usable_size",{Value::word(aligned)})==8);
    std::array<unsigned char,12> copied{};auto copiedGuest=memory->borrow(copied.data(),copied.size(),Memory::Read|Memory::Write);
    assert(call("memcpy",{Value::word(copiedGuest),Value::word(aligned),Value::word(copied.size())})==copiedGuest);
    for(auto byte:copied)assert(byte==0x5a);
    assert(memory->translate(aligned,resource_shapes::allocationAlignment,Memory::Read)==alignmentAllocation);
    bool outside=false;try{memory->translate(aligned,resource_shapes::allocationAlignment+1,Memory::Read);}catch(const Memory::Fault &){outside=true;}
    assert(outside&&"Addressability does not round beyond the original native alignment unit");
    const auto tailAlias=memory->borrow(alignmentAllocation+12,1,Memory::Read);
    call("free",{Value::word(aligned)});retired(aligned);retired(tailAlias);alignmentAllocationMode=false;
    assert(munmap(guarded,page*2)==0);alignmentAllocation=nullptr;
    auto original=uint32_t(call("malloc",{Value::word(64)}));assert(original);
    allocationAliases={original,memory->borrow(firstAllocation.data()+16,8,Memory::Read),memory->borrow(firstAllocation.data(),32,Memory::Read)};
    expectedInputError=ERANGE;reuseOnFree=true;call("free",{Value::word(original)});assert(errno==EBUSY);
    assert(reusedAllocation&&memory->translate(reusedAllocation,128,Memory::Read)==firstAllocation.data());
    // Failed realloc preserves the old pointer, bytes, aliases and error.
    firstAllocation[0]=0x63;allocationAliases={};failRealloc=true;
    assert(call("realloc",{Value::word(reusedAllocation),Value::word(96)})==0&&errno==ENOMEM);
    assert(memory->translate(reusedAllocation,128,Memory::Read)==firstAllocation.data()&&firstAllocation[0]==0x63);
    // Successful realloc retires every old alias before publishing its result.
    allocationAliases={reusedAllocation,memory->borrow(firstAllocation.data()+32,4,Memory::Read),0};failRealloc=false;
    auto resized=uint32_t(call("realloc",{Value::word(reusedAllocation),Value::word(96)}));assert(resized&&errno==EAGAIN);
    assert(memory->translate(resized,128,Memory::Read)==secondAllocation.data());
    // The lowest free guest address may be reused for the new allocation;
    // the distinct interior old alias must nevertheless have retired.
    if(allocationAliases[1]<resized||uint64_t(allocationAliases[1])>=uint64_t(resized)+secondAllocation.size())retired(allocationAliases[1]);
    assert(!memory->addressOf(firstAllocation.data()));
    allocationAliases={resized,0,0};call("free",{Value::word(resized)});
    struct {uint32_t pointer,guard;} output{0,0xcafed00d};
    auto slot=memory->borrow(&output,sizeof output,Memory::Read|Memory::Write);
    assert(call("getaddrinfo",{Value::word(0),Value::word(0),Value::word(0),Value::word(slot)})==0&&output.guard==0xcafed00d);
    assert(guestPointer(output.pointer,resource_shapes::nextGuest)==output.pointer);
    resolverAliases={output.pointer,guestPointer(output.pointer,resource_shapes::canonicalGuest),guestPointer(output.pointer,resource_shapes::addressGuest),
        memory->borrow(resolver.data()+4,4,Memory::Read),memory->borrow(canonical+3,4,Memory::Read),memory->borrow(addressBytes.data()+20,4,Memory::Read)};
    call("freeaddrinfo",{Value::word(output.pointer)});assert(resolverReleased&&errno==EINTR);
    // An unrelated later import must not reread the retired/poisoned native row.
    call("getpid",{});
    // Native resource owners can release storage internally, without a guest
    // free() import. A subsequent successful allocation is definitive evidence
    // of a new lifetime, even when the allocator reuses that physical address.
    char filename[]="original-resource";auto name=memory->borrow(filename,sizeof filename,Memory::Read);
    auto asset=uint32_t(call("AAssetManager_open",{Value::word(0),Value::word(name),Value::word(0)}));assert(asset);
    bool bounded=false;try{memory->translate(asset+1,1,Memory::Read);}catch(const Memory::Fault&){bounded=true;}assert(bounded);
    auto interior=memory->borrow(firstAllocation.data()+8,1,Memory::Read);
    call("AAsset_close",{Value::word(asset)});assert(assetReleased);
    auto fresh=uint32_t(call("malloc",{Value::word(32)}));assert(fresh);
    assert(memory->translate(fresh,firstAllocation.size(),Memory::Read|Memory::Write)==firstAllocation.data());
    assert(memory->addressOf(firstAllocation.data()+8)==fresh+8);
    if(interior<fresh||uint64_t(interior)>=uint64_t(fresh)+firstAllocation.size())retired(interior);
    output.pointer=0;
    assert(call("getaddrinfo",{Value::word(0),Value::word(0),Value::word(0),Value::word(slot)})==0);
    auto oldInterior=memory->borrow(resolver.data()+16,4,Memory::Read);
    reuseResolverAllocation=true;
    auto recycled=uint32_t(call("malloc",{Value::word(32)}));
    assert(mprotect(resolver.data(),resolver.size(),PROT_READ|PROT_WRITE)==0);
    assert(memory->translate(recycled,resolver.size(),Memory::Read|Memory::Write)==resolver.data());
    // The larger new allocation may legitimately reuse the old guest page;
    // the native interval must nevertheless resolve through the new lifetime.
    assert(memory->addressOf(resolver.data()+16)==recycled+16);
    if(oldInterior<recycled||uint64_t(oldInterior)>=uint64_t(recycled)+resolver.size())retired(oldInterior);
    std::cout<<"PASS native release, alias reuse, realloc failure and complete typed resolver retirement\n";
}

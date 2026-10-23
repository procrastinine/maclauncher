#include "arm32.h"
#include "native-imports.h"
#include <array>
#include <cassert>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <time.h>
using namespace maclauncher::arm32;
static Thread *active;
static uint32_t nested;
static unsigned largeCalls;
static uint64_t largeChecksum;
static std::array<float,4> observed;
static long nativeLong(long value){return value<0?-value:value;}
static int nativeAbs(int value){if(value==-17){std::array<Value,1> values{Value::word(uint32_t(-9))};return int(active->call(nested,values))+17;}return value<0?-value:value;}
static void nativeColor(float a,float b,float c,float d){observed={a,b,c,d};}
static void nativeLarge(unsigned a,unsigned b,int c,int d,int e,int f,unsigned g,unsigned h,int i,int j,int k,int l,int m,int n,int o){
 ++largeCalls;largeChecksum+=a+b+unsigned(c+d+e+f)+g+h+unsigned(i+j+k+l+m+n+o);
}
static void *lookup(const char *name){if(!std::strcmp(name,"abs"))return reinterpret_cast<void*>(nativeAbs);if(!std::strcmp(name,"labs"))return reinterpret_cast<void*>(nativeLong);if(!std::strcmp(name,"glClearColor"))return reinterpret_cast<void*>(nativeColor);if(!std::strcmp(name,"glCopyImageSubData"))return reinterpret_cast<void*>(nativeLarge);return nullptr;}
static uint64_t cpu(){timespec value{};assert(!clock_gettime(CLOCK_THREAD_CPUTIME_ID,&value));return uint64_t(value.tv_sec)*1000000000+value.tv_nsec;}
int main(){
 Memory memory;Imports imports(memory,lookup);Thread thread(memory);active=&thread;
 auto scalar=imports.resolve("abs"),color=imports.resolve("glClearColor"),large=imports.resolve("glCopyImageSubData");nested=imports.resolve("labs");assert(scalar&&nested&&color&&large);
 // Nested calls retain both invocation frames until the original outer ffi
 // call returns. Different scalar widths exercise the shared original ABI.
 std::array<Value,1> reentrant{Value::word(uint32_t(-17))};assert(thread.call(scalar,reentrant)==26);
 std::array<Value,4> floats;std::array<float,4> values{.125f,-.75f,1.25f,0.0f};for(unsigned i=0;i<4;i++)floats[i]=Value::word(std::bit_cast<uint32_t>(values[i]));thread.call(color,floats);assert(observed==values);
 // Fifteen original GLES parameters exceed the inline scratch extent. Heap
 // fallback retains every stack argument; no method/argument limit is added.
 std::array<Value,15> many;for(unsigned i=0;i<many.size();i++)many[i]=Value::word(i+1);
 for(unsigned i=0;i<100;i++)thread.call(large,many);assert(largeCalls==100&&largeChecksum==12000);
 std::array<Value,1> argument;uint64_t checksum=0;for(unsigned i=0;i<1000;i++){argument[0]=Value::word(uint32_t(-int(i+100)));checksum+=thread.call(scalar,argument);}
 const uint64_t begin=cpu();for(unsigned i=0;i<100000;i++){argument[0]=Value::word(uint32_t(-int(i+100)));checksum+=thread.call(scalar,argument);}const uint64_t elapsed=cpu()-begin;
 assert(checksum==5010549500ULL);
 std::printf("{\"calls\":100000,\"cpuNs\":%llu,\"checksum\":%llu,\"reentrant\":true,\"floatAbi\":true,\"largeArguments\":15}\n",(unsigned long long)elapsed,(unsigned long long)checksum);
}

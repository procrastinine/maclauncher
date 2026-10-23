#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <chrono>
#include <cstdio>
int main(){@autoreleasepool{
    id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device)return 1;
    MTLCompileOptions *options=[MTLCompileOptions new];
    // Each test bundle selects a fresh module configuration, so a globally
    // cached library cannot conceal denied writes during cold compilation.
    options.preprocessorMacros=@{@"MACLAUNCHER_CACHE_FIXTURE":@([NSBundle.mainBundle.bundleIdentifier hash])};
    for(int i=0;i<3;i++){
        NSString *source=[NSString stringWithFormat:@"#include <metal_stdlib>\nusing namespace metal;kernel void work(device float* p [[buffer(0)]],uint x [[thread_position_in_grid]]) {float y=p[x];for(uint k=0;k<%d;k++)y=sin(y*1.123)+cos(y*.631);p[x]=y;}",31+i];
        auto start=std::chrono::steady_clock::now();NSError *error=nil;
        options.languageVersion=i==0?MTLLanguageVersion2_1:i==1?MTLLanguageVersion2_3:MTLLanguageVersion3_1;
        id<MTLLibrary> library=[device newLibraryWithSource:source options:options error:&error];
        if(!library){fprintf(stderr,"%s\n",error.description.UTF8String);return 2;}
        id<MTLFunction> function=[library newFunctionWithName:@"work"];
        if(![device newComputePipelineStateWithFunction:function error:&error])return 3;
        printf("shader=%d elapsedMs=%.3f\n",i,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());
    }
}}

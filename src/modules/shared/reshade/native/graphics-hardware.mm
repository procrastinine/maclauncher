// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#import <objc/message.h>
#include <cmath>
#include <cstdio>

namespace {
NSMutableDictionary*operation(NSString*minimum){
    return [@{@"supported":@NO,@"metal4Supported":@NO,@"minimumMacOS":minimum} mutableCopy];
}
NSString*failure(NSException*error){return error.reason?:@"The MetalFX device query failed";}
// Capability probing uses the runtime API rather than requiring the build SDK
// to declare every optional operation. Execution retains its own compiled API
// contract; these probes only report the actual OS/device support.
void support(NSMutableDictionary*row,Class descriptor,id<MTLDevice>device,bool metal4=false){
    NSString*key=metal4?@"metal4Supported":@"supported",*reason=metal4?@"metal4Reason":@"reason";
    const SEL query=NSSelectorFromString(metal4?@"supportsMetal4FX:":@"supportsDevice:");
    if(!descriptor||![descriptor respondsToSelector:query]){row[reason]=@"The MetalFX device query API is unavailable";return;}
    @try{row[key]=@(reinterpret_cast<BOOL(*)(id,SEL,id<MTLDevice>)>(objc_msgSend)(descriptor,query,device));}
    @catch(NSException*error){row[reason]=failure(error);}
}
void scale(NSMutableDictionary*row,Class descriptor,id<MTLDevice>device){
    if(![row[@"supported"] boolValue])return;
    const SEL minimumQuery=NSSelectorFromString(@"supportedInputContentMinScaleForDevice:"),
        maximumQuery=NSSelectorFromString(@"supportedInputContentMaxScaleForDevice:");
    if(!descriptor||![descriptor respondsToSelector:minimumQuery]||![descriptor respondsToSelector:maximumQuery]){row[@"scaleReason"]=@"The MetalFX scale query API is unavailable";return;}
    @try{
        const auto query=reinterpret_cast<float(*)(id,SEL,id<MTLDevice>)>(objc_msgSend);
        const float minimum=query(descriptor,minimumQuery,device),maximum=query(descriptor,maximumQuery,device);
        if(std::isfinite(minimum)&&std::isfinite(maximum)&&minimum>0&&maximum>=minimum){row[@"minScale"]=@(minimum);row[@"maxScale"]=@(maximum);}
        else row[@"scaleReason"]=@"MetalFX returned an invalid scale interval";
    }@catch(NSException*error){row[@"scaleReason"]=failure(error);}
}
NSDictionary*capabilities(id<MTLDevice>device){
    auto spatial=operation(@"13.0"),temporal=operation(@"13.0"),denoised=operation(@"26.0"),interpolation=operation(@"26.0");
    temporal[@"minScale"]=temporal[@"maxScale"]=[NSNull null];
    denoised[@"minScale"]=denoised[@"maxScale"]=[NSNull null];
    if(!device){
        for(NSMutableDictionary*row in @[spatial,temporal,denoised,interpolation])row[@"reason"]=@"No Metal device is available";
        return @{@"spatial":spatial,@"temporal":temporal,@"denoised":denoised,@"interpolation":interpolation};
    }
    Class spatialType=MTLFXSpatialScalerDescriptor.class,temporalType=MTLFXTemporalScalerDescriptor.class,
        denoisedType=NSClassFromString(@"MTLFXTemporalDenoisedScalerDescriptor"),interpolationType=NSClassFromString(@"MTLFXFrameInterpolatorDescriptor");
    if(@available(macOS 13.0,*)){
        support(spatial,spatialType,device);support(temporal,temporalType,device);
    }
    if(@available(macOS 14.0,*))scale(temporal,temporalType,device);
    else temporal[@"scaleReason"]=@"Temporal scale queries require macOS 14 or later";
    if(@available(macOS 26.0,*)){
        support(spatial,spatialType,device,true);support(temporal,temporalType,device,true);
        support(denoised,denoisedType,device);support(denoised,denoisedType,device,true);scale(denoised,denoisedType,device);
        support(interpolation,interpolationType,device);support(interpolation,interpolationType,device,true);
    }else{
        for(NSMutableDictionary*row in @[denoised,interpolation])row[@"reason"]=@"Requires macOS 26 or later";
        for(NSMutableDictionary*row in @[spatial,temporal,denoised,interpolation])row[@"metal4Reason"]=@"Metal 4 requires macOS 26 or later";
    }
    return @{@"spatial":spatial,@"temporal":temporal,@"denoised":denoised,@"interpolation":interpolation};
}
NSDictionary*identity(id<MTLDevice>device){
    return device?@{@"name":device.name?:@"Metal device",@"registryID":[NSString stringWithFormat:@"%llu",(unsigned long long)device.registryID]}:
        @{@"name":[NSNull null],@"registryID":[NSNull null]};
}
}
int main(){@autoreleasepool{@try{
    const auto selected=MTLCreateSystemDefaultDevice();
    NSMutableArray*devices=[NSMutableArray array];
    NSDictionary*selectedCapabilities=nil;
    for(id<MTLDevice>device in MTLCopyAllDevices()){
        NSMutableDictionary*row=[identity(device) mutableCopy];row[@"isDefault"]=@(selected&&device.registryID==selected.registryID);
        row[@"metalfx"]=capabilities(device);if([row[@"isDefault"] boolValue])selectedCapabilities=row[@"metalfx"];[devices addObject:row];
    }
    const auto result=@{@"schema":@1,@"device":identity(selected),@"metalfx":selectedCapabilities?:capabilities(selected),@"devices":devices};
    NSError*error=nil;auto json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:&error];
    if(!json){std::fprintf(stderr,"%s\n",error.localizedDescription.UTF8String?:"Cannot serialize graphics hardware metadata");return 1;}
    std::fwrite(json.bytes,1,json.length,stdout);std::fputc('\n',stdout);return 0;
}@catch(NSException*error){std::fprintf(stderr,"%s\n",failure(error).UTF8String);return 1;}}}

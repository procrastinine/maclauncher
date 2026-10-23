#pragma once
#import <Foundation/Foundation.h>
#include "resolution-scale.hpp"
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <initializer_list>
#include <optional>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>

namespace macfx {
struct SourceControlCommand {
    uint64_t epoch=0;
    std::string revision;
    std::optional<RenderSourceRequest> source;
    id requested=NSNull.null;
};
// Main-thread reader for one launch. It has no timer or AppKit dependency and
// is constructed for an explicitly requested source in its selected
// presentation. A source already at its target needs no virtual session.
class SourceControlReader {
    std::string file,status,launch;
    std::string previousBytes;
    ino_t previousInode=0;off_t previousSize=-1;timespec previousTime{};
    uint64_t acceptedEpoch=0;
    std::string acceptedRevision;
    std::string previousStatus;
    static bool boolean(id value){return value&&CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID();}
    static bool number(id value){return [value isKindOfClass:NSNumber.class]&&!boolean(value)&&std::isfinite([value doubleValue]);}
    static void fields(id value,std::initializer_list<NSString*> names){
        if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("Render source controls must contain an object.");
        for(id key in value){bool found=false;for(NSString *name:names)found|=[key isEqual:name];
            if(!found)throw std::runtime_error("Render source controls contain unsupported fields.");}
    }
public:
    SourceControlReader(){
        const char *input=std::getenv("RESHADE_RENDER_SOURCE_CONTROL_FILE"),*output=std::getenv("RESHADE_RENDER_SOURCE_STATUS_FILE"),
            *identity=std::getenv("RESHADE_RENDER_SOURCE_LAUNCH_ID");
        if(!input||!*input||!output||!*output||!identity||!*identity)return;
        launch=identity;
        if(launch.size()>128||launch.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")!=std::string::npos){launch.clear();return;}
        NSString *in=[NSString stringWithUTF8String:input],*out=[NSString stringWithUTF8String:output];
        if(!in.isAbsolutePath||!out.isAbsolutePath||![in.stringByDeletingLastPathComponent isEqual:out.stringByDeletingLastPathComponent]||
           ![in.lastPathComponent isEqual:[NSString stringWithFormat:@"source-control-%s.json",identity]]||
           ![out.lastPathComponent isEqual:[NSString stringWithFormat:@"source-status-%s.json",identity]]){launch.clear();return;}
        file=input;status=output;
    }
    bool configured()const{return !file.empty();}
    const std::string &launchId()const{return launch;}
    static SourceControlCommand parse(NSData *data,const std::string &launchId){
        if(!data.length||data.length>4096)throw std::runtime_error("Render source controls exceed their size limit.");
        NSError *error=nil;id raw=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if(!raw||error)throw std::runtime_error("Render source controls contain invalid JSON.");
        fields(raw,{@"schema",@"launchId",@"epoch",@"revision",@"control",@"source"});NSDictionary *root=raw;
        if(!number(root[@"schema"])||[root[@"schema"] doubleValue]!=1||![root[@"launchId"] isEqual:[NSString stringWithUTF8String:launchId.c_str()]]||
           ![root[@"control"] isEqual:@"virtual"]||!root[@"source"]||!number(root[@"epoch"]))
            throw std::runtime_error("Render source controls belong to another launch or control.");
        const double epoch=[root[@"epoch"] doubleValue];id revision=root[@"revision"];
        if(epoch<1||epoch>9007199254740991.0||std::floor(epoch)!=epoch||![revision isKindOfClass:NSString.class]||[revision length]!=64||
           [revision rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location!=NSNotFound)
            throw std::runtime_error("Render source control identity is invalid.");
        SourceControlCommand result;result.epoch=uint64_t(epoch);result.revision=[revision UTF8String];result.requested=root[@"source"];
        if(result.requested==NSNull.null)return result;
        fields(result.requested,{@"height",@"maximum",@"multiplier",@"method",@"automatic"});NSDictionary *source=result.requested;
        if(id automatic=source[@"automatic"]){
            if(!boolean(automatic)||![automatic boolValue]||source.count!=1)
                throw std::runtime_error("Automatic render source controls must contain only automatic: true.");
            RenderSourceRequest request;request.automatic=true;result.source=request;return result;
        }
        if(bool(source[@"height"])==bool(source[@"multiplier"]))throw std::runtime_error("Choose a render height or an available divisor.");
        RenderSourceRequest request;
        if(source[@"height"]){
            const double height=[source[@"height"] isKindOfClass:NSNumber.class]?[source[@"height"] doubleValue]:0;
            if(!number(source[@"height"])||height<1||height>16384||std::floor(height)!=height)throw std::runtime_error("The render height is invalid.");
            if(source[@"maximum"]&&!boolean(source[@"maximum"]))throw std::runtime_error("The render height limit is invalid.");
            if([source[@"maximum"] boolValue])request.maximum=unsigned(height);else request.height=unsigned(height);
        }else{
            const double divisor=[source[@"multiplier"] isKindOfClass:NSNumber.class]?[source[@"multiplier"] doubleValue]:0;
            if(!number(source[@"multiplier"])||source[@"maximum"]||(divisor!=1&&divisor!=1.5&&divisor!=2&&divisor!=3))
                throw std::runtime_error("The render divisor is invalid.");
            request.multiplier=divisor;
        }
        // Virtual allocation has no renderer-specific native filter selector.
        if(source[@"method"])throw std::runtime_error("Virtual source allocation does not select an engine filter.");
        result.source=request;return result;
    }
    std::optional<SourceControlCommand> poll(){
        if(!configured())return {};
        int descriptor=open(file.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(descriptor<0){if(errno==ENOENT)return {};throw std::runtime_error("Render source controls could not be read.");}
        struct Guard{int descriptor;~Guard(){close(descriptor);}}guard{descriptor};struct stat info{};
        if(fstat(descriptor,&info)||!S_ISREG(info.st_mode)||info.st_size<1||info.st_size>4096)throw std::runtime_error("Render source controls must be bounded ordinary files.");
        if(info.st_ino==previousInode&&info.st_size==previousSize&&info.st_mtimespec.tv_sec==previousTime.tv_sec&&info.st_mtimespec.tv_nsec==previousTime.tv_nsec)return {};
        char bytes[4097];size_t count=0;
        while(count<sizeof(bytes)){ssize_t length=read(descriptor,bytes+count,sizeof(bytes)-count);if(length<0&&errno==EINTR)continue;
            if(length<0)throw std::runtime_error("Render source controls could not be read.");if(!length)break;count+=size_t(length);}
        if(count>4096)throw std::runtime_error("Render source controls exceed their size limit.");
        previousInode=info.st_ino;previousSize=info.st_size;previousTime=info.st_mtimespec;
        std::string current(bytes,count);if(current==previousBytes)return {};previousBytes=current;
        auto command=parse([NSData dataWithBytes:bytes length:count],launch);
        if(command.epoch<acceptedEpoch||(command.epoch==acceptedEpoch&&command.revision!=acceptedRevision))throw std::runtime_error("An older render source change was ignored.");
        if(command.epoch==acceptedEpoch)return {};return command;
    }
    void accept(const SourceControlCommand &command){acceptedEpoch=command.epoch;acceptedRevision=command.revision;}
    void writeStatus(const SourceControlCommand &command,id applied,NSString *reason,bool sessionReady=false,std::optional<RenderSourceSize> observed={}){
        if(!configured())return;
        NSMutableDictionary *value=[@{@"schema":@1,@"launchId":[NSString stringWithUTF8String:launch.c_str()],@"control":@"virtual",
            @"epoch":@(command.epoch),@"revision":[NSString stringWithUTF8String:command.revision.c_str()],@"requested":command.requested?:NSNull.null,
            @"applied":applied?:NSNull.null,@"reason":reason?:@"",@"sessionReady":@(sessionReady)} mutableCopy];
        if(observed)value[@"observed"] = @{@"width":@(std::round(observed->width)),@"height":@(std::round(observed->height))};
        NSData *data=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
        if(!data||data.length>8192)return;std::string bytes(static_cast<const char*>(data.bytes),data.length);if(bytes==previousStatus)return;
        std::string temporary=status+".tmp-XXXXXX";
        int descriptor=mkstemp(temporary.data());if(descriptor<0)return;fcntl(descriptor,F_SETFD,FD_CLOEXEC);
        bool complete=true;size_t offset=0;
        while(offset<bytes.size()){const ssize_t count=write(descriptor,bytes.data()+offset,bytes.size()-offset);if(count<0&&errno==EINTR)continue;
            if(count<=0){complete=false;break;}offset+=size_t(count);}
        if(close(descriptor))complete=false;if(complete&&rename(temporary.c_str(),status.c_str())==0)previousStatus=std::move(bytes);else unlink(temporary.c_str());
    }
};
}

#include "presentation-hold.hpp"
#include "view-presentation.hpp"
#include "live-controls.hpp"
#include "log.hpp"
#include "native-config.hpp"
#import <CommonCrypto/CommonDigest.h>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <initializer_list>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace {
bool identity(id value,unsigned maximum=128){return [value isKindOfClass:NSString.class]&&[value length]>0&&[value length]<=maximum&&
    [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet]].location==NSNotFound;}
bool digest(id value){return [value isKindOfClass:NSString.class]&&[value length]==64&&
    [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location==NSNotFound;}
void fields(id value,std::initializer_list<NSString*> allowed){
    if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("Presentation controls require an object.");
    for(id key in value){bool found=false;for(id name:allowed)found|=[key isEqual:name];if(!found)throw std::runtime_error("Presentation controls contain unsupported fields.");}
}
macfx::PresentationContract contract(id value,bool candidate=false){
    if(candidate)fields(value,{@"planRevision",@"controlsDigest",@"requiresPresentation"});else fields(value,{@"planRevision",@"controlsDigest"});
    if(!digest(value[@"planRevision"])||!digest(value[@"controlsDigest"])||
       candidate&&(!value[@"requiresPresentation"]||CFGetTypeID((__bridge CFTypeRef)value[@"requiresPresentation"])!=CFBooleanGetTypeID()||![value[@"requiresPresentation"] boolValue]))
        throw std::runtime_error("Presentation controls require an owned-output contract.");
    return {[value[@"planRevision"] UTF8String],[value[@"controlsDigest"] UTF8String]};
}
std::string hash(const void *bytes,size_t length){unsigned char result[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes,CC_LONG(length),result);char hex[65];
    for(unsigned i=0;i<sizeof(result);++i)std::snprintf(hex+i*2,3,"%02x",result[i]);return hex;}
}
bool macfx::presentationHoldConfigured()noexcept{return nativeConfig().presentationHold.configured();}
std::string macfx::presentationControlsDigest(){
    if(!presentationHoldConfigured())return {};
    const auto &state=liveState();const auto packet=state.controls.get();if(!packet)return {};
    thread_local uint64_t generation=~uint64_t(0);thread_local std::string value;
    if(generation!=state.generation){value=hash(packet,sizeof(*packet));generation=state.generation;}return value;
}
struct macfx::PresentationHoldReader::Impl {
    std::string file,output,launch,token,lastStatus;uint64_t epoch=0;ino_t inode=0;timespec modified{};
};
macfx::PresentationHoldReader::PresentationHoldReader():impl(std::make_unique<Impl>()){
    const auto &hold=nativeConfig().presentationHold;
    if(!hold.controlFile||!hold.statusFile||!hold.launchId||!hold.token)return;
    const auto &file=*hold.controlFile,&output=*hold.statusFile,&launch=*hold.launchId,&token=*hold.token;
    NSString *input=@(file.c_str()),*status=@(output.c_str()),*launchId=@(launch.c_str()),*secret=@(token.c_str());
    if(!identity(launchId)||!identity(secret)||!input.isAbsolutePath||!status.isAbsolutePath||
       ![input.stringByDeletingLastPathComponent isEqual:status.stringByDeletingLastPathComponent]||
       ![input.lastPathComponent isEqual:[NSString stringWithFormat:@"presentation-control-%@.json",launchId]]||
       ![status.lastPathComponent isEqual:[NSString stringWithFormat:@"presentation-status-%@.json",launchId]])return;
    impl->file=file;impl->output=output;impl->launch=launch;impl->token=token;
}
macfx::PresentationHoldReader::~PresentationHoldReader()=default;
bool macfx::PresentationHoldReader::configured()const{return !impl->file.empty();}
macfx::PresentationHoldCommand macfx::PresentationHoldReader::parse(NSData *data,const std::string &launch,const std::string &token){
    if(!data.length||data.length>4096)throw std::runtime_error("Presentation controls exceed their size limit.");
    NSError *error=nil;id root=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if(error)throw std::runtime_error("Presentation controls contain invalid JSON.");
    fields(root,{@"schema",@"launchId",@"token",@"epoch",@"transactionId",@"action",@"expected",@"candidate"});
    id schema=root[@"schema"],epoch=root[@"epoch"];
    if(![schema isKindOfClass:NSNumber.class]||CFGetTypeID((__bridge CFTypeRef)schema)==CFBooleanGetTypeID()||[schema doubleValue]!=1||
       ![root[@"launchId"] isEqual:@(launch.c_str())]||![root[@"token"] isEqual:@(token.c_str())]||!identity(root[@"transactionId"])||
       ![epoch isKindOfClass:NSNumber.class]||CFGetTypeID((__bridge CFTypeRef)epoch)==CFBooleanGetTypeID()||
       !std::isfinite([epoch doubleValue])||[epoch doubleValue]<1||[epoch doubleValue]>9007199254740991.0||std::floor([epoch doubleValue])!=[epoch doubleValue])
        throw std::runtime_error("Presentation controls belong to another launch or epoch.");
    id action=root[@"action"];if(![action isEqual:@"hold"]&&![action isEqual:@"present"]&&![action isEqual:@"cancel"]&&![action isEqual:@"finish"]&&![action isEqual:@"abandon"])
        throw std::runtime_error("Presentation control action is invalid.");
    PresentationHoldCommand result;result.epoch=[epoch unsignedLongLongValue];result.transactionId=[root[@"transactionId"] UTF8String];result.action=[action UTF8String];
    result.expected=contract(root[@"expected"]);
    if(result.action=="hold")result.candidate=contract(root[@"candidate"],true);
    else if(root[@"candidate"])throw std::runtime_error("Only a hold can select a presentation candidate.");
    return result;
}
std::optional<macfx::PresentationHoldCommand> macfx::PresentationHoldReader::poll(){
    if(!configured())return {};
    int fd=open(impl->file.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0){if(errno==ENOENT)return {};throw std::runtime_error("Presentation controls could not be read.");}
    struct Close{int fd;~Close(){close(fd);}}closeFile{fd};struct stat before{},after{},named{};
    if(fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_size<1||before.st_size>4096)throw std::runtime_error("Presentation controls must be bounded ordinary files.");
    if(before.st_ino==impl->inode&&before.st_mtimespec.tv_sec==impl->modified.tv_sec&&before.st_mtimespec.tv_nsec==impl->modified.tv_nsec)return {};
    std::string bytes(size_t(before.st_size),'\0');size_t count=0;
    while(count<bytes.size()){const auto n=pread(fd,bytes.data()+count,bytes.size()-count,count);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("Presentation controls changed while reading.");count+=size_t(n);}
    if(fstat(fd,&after)||lstat(impl->file.c_str(),&named)||before.st_ino!=after.st_ino||before.st_size!=after.st_size||
       before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec||before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec||
       named.st_ino!=before.st_ino||named.st_size!=before.st_size||named.st_mtimespec.tv_sec!=before.st_mtimespec.tv_sec||named.st_mtimespec.tv_nsec!=before.st_mtimespec.tv_nsec)
        throw std::runtime_error("Presentation controls changed while reading.");
    auto value=parse([NSData dataWithBytes:bytes.data() length:bytes.size()],impl->launch,impl->token);
    impl->inode=before.st_ino;impl->modified=before.st_mtimespec;if(value.epoch<=impl->epoch)return {};impl->epoch=value.epoch;return value;
}
void macfx::PresentationHoldReader::status(const PresentationHoldStatus &value,unsigned window){
    if(!configured()||!value.epoch)return;
    NSDictionary *record=@{@"schema":@1,@"launchId":@(impl->launch.c_str()),@"token":@(impl->token.c_str()),@"epoch":@(value.epoch),
        @"transactionId":@(value.transactionId.c_str()),@"state":@(value.state.c_str()),@"window":@(window),@"frameId":@(value.frameId),
        @"width":@(value.width),@"height":@(value.height),@"presentedTime":@(value.presentedTime),@"planRevision":@(value.contract.planRevision.c_str()),
        @"controlsDigest":@(value.contract.controlsDigest.c_str()),@"reason":@(value.reason.c_str()),@"holding":@(value.holding)};
    NSData *data=[NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:nil];if(!data)return;
    std::string bytes(static_cast<const char*>(data.bytes),data.length);if(bytes==impl->lastStatus)return;
    const std::string temporary=impl->output+".tmp-"+std::to_string(getpid());int fd=open(temporary.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(fd<0){if(errno==EEXIST)unlink(temporary.c_str());return;}size_t count=0;
    while(count<bytes.size()){const auto n=write(fd,bytes.data()+count,bytes.size()-count);if(n<0&&errno==EINTR)continue;if(n<=0)break;count+=size_t(n);}close(fd);
    if(count==bytes.size()&&rename(temporary.c_str(),impl->output.c_str())==0)impl->lastStatus=std::move(bytes);else unlink(temporary.c_str());
}
void macfx::pollPresentationHold(const std::function<std::shared_ptr<ViewPresentation>(std::string &)> &select){
    if(!presentationHoldConfigured())return;
    // Hooks can be called during AppKit's late process teardown.
    struct State{PresentationHoldReader reader;std::shared_ptr<ViewPresentation> owner;PresentationHoldStatus last;unsigned window=0;std::string reported;};
    static auto *const state=new State;
    if(!state->reader.configured())return;
    try{
        if(auto command=state->reader.poll()){
            if(command->action=="hold"){
                if(state->owner&&state->owner->presentationHeld()){
                    state->last={};state->last.state="failed";state->last.epoch=command->epoch;state->last.transactionId=command->transactionId;state->last.reason="Another presentation update is still held";state->last.holding=true;
                }else{
                    std::string reason;auto selected=select(reason);
                    if(!selected){state->last={};state->last.state="failed";state->last.epoch=command->epoch;state->last.transactionId=command->transactionId;
                        state->last.reason=reason.empty()?"A visible owned opaque SDR presentation is required":reason;state->window=0;}
                    else {state->owner=selected;state->window=selected->presentationWindow();state->last=selected->beginPresentationHold(*command);}
                }
            }else if(state->owner&&state->owner->presentationHeld())state->last=state->owner->resumePresentationHold(*command);
            else {state->last={};state->last.state="failed";state->last.epoch=command->epoch;state->last.transactionId=command->transactionId;state->last.reason="The owned presentation hold is no longer active";}
        }
        if(state->owner&&state->owner->presentationHeld()){const auto current=state->owner->presentationHoldStatus();if(current.epoch>=state->last.epoch)state->last=current;state->last.holding=current.holding;}
        else {if(state->owner){const auto final=state->owner->presentationHoldStatus();if(final.epoch&&final.epoch>=state->last.epoch)state->last=final;state->owner.reset();}state->last.holding=false;}
        state->reader.status(state->last,state->window);
    }catch(const std::exception &error){if(state->reported!=error.what()){state->reported=error.what();nativeLog("Presentation controls: "+state->reported);}}
}

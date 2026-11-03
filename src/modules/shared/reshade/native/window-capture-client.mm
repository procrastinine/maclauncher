// Copyright (c) MacLauncher contributors. MIT license.
#include "window-capture-client.hpp"
#include <servers/bootstrap.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>
#include <string>

namespace macfx::wcap {
namespace {
using Clock=std::chrono::steady_clock;
double now(){return std::chrono::duration<double>(Clock::now().time_since_epoch()).count();}
bool sameExecutable(pid_t process){char path[PROC_PIDPATHINFO_MAXSIZE]{};return process>0&&proc_pidpath(process,path,sizeof(path))>0&&[executablePath() isEqualToString:@(path)];}
uint64_t processBirth(pid_t process){proc_bsdinfo info{};return proc_pidinfo(process,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)?
    uint64_t(info.pbi_start_tvsec)*1000000+info.pbi_start_tvusec:0;}
NSDictionary*readRendezvous(NSString*path){
    const int file=open(path.fileSystemRepresentation,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(file<0)return nil;
    struct stat status{};char bytes[4096]{};
    const bool safe=fstat(file,&status)==0&&S_ISREG(status.st_mode)&&status.st_uid==getuid()&&status.st_size>0&&status.st_size<sizeof(bytes);
    const auto count=safe?pread(file,bytes,sizeof(bytes)-1,0):-1;close(file);
    if(count<=0)return nil;
    id value=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:count] options:0 error:nil];
    return [value isKindOfClass:NSDictionary.class]?value:nil;
}
void launchService(NSString*identifier){
    NSString*executable=executablePath();if(!executable)return;
    std::vector<std::string> environment;
    NSDictionary<NSString*,NSString*>*values=NSProcessInfo.processInfo.environment;
    for(NSString*key in values){const std::string name=key.UTF8String;
        if(name=="HOME"||name=="TMPDIR"||name=="CFFIXED_USER_HOME"||name=="LANG"||name=="TZ"||name=="__CF_USER_TEXT_ENCODING"||name.rfind("LC_",0)==0)environment.push_back(name+"="+values[key].UTF8String);
    }
    environment.emplace_back("PATH=/usr/bin:/bin");
    std::vector<char*> pointers;for(auto&entry:environment)pointers.push_back(entry.data());pointers.push_back(nullptr);
    const char*arguments[]={executable.fileSystemRepresentation,"--capture-service",identifier.UTF8String,nullptr};
    posix_spawnattr_t attributes;posix_spawnattr_init(&attributes);posix_spawnattr_setflags(&attributes,POSIX_SPAWN_SETSID|POSIX_SPAWN_CLOEXEC_DEFAULT);
    // The singleton outlives individual chains. Inheriting a chain's pipes
    // would keep its launcher's close event waiting until the service exits.
    posix_spawn_file_actions_t files;posix_spawn_file_actions_init(&files);
    posix_spawn_file_actions_addopen(&files,STDIN_FILENO,"/dev/null",O_RDONLY,0);
    posix_spawn_file_actions_addopen(&files,STDOUT_FILENO,"/dev/null",O_WRONLY,0);
    posix_spawn_file_actions_addopen(&files,STDERR_FILENO,"/dev/null",O_WRONLY,0);
    pid_t process=0;const auto launched=posix_spawn(&process,executable.fileSystemRepresentation,&files,&attributes,const_cast<char*const*>(arguments),pointers.data());
    posix_spawn_file_actions_destroy(&files);posix_spawnattr_destroy(&attributes);
    if(launched)return;
    __block dispatch_source_t watcher=dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,process,DISPATCH_PROC_EXIT,dispatch_get_global_queue(QOS_CLASS_UTILITY,0));
    if(!watcher){std::thread([process]{waitpid(process,nullptr,0);}).detach();return;}
    dispatch_source_set_event_handler(watcher,^{waitpid(process,nullptr,WNOHANG);dispatch_source_cancel(watcher);watcher=nil;});dispatch_resume(watcher);
}
}

struct Client::Impl:std::enable_shared_from_this<Client::Impl>{
    NSString*identifier;NSString*path;NSString*role;ClientCallbacks callbacks;
    mach_port_t local=MACH_PORT_NULL,remote=MACH_PORT_NULL;
    std::atomic<bool>stopped{false};std::atomic<pid_t>process{0};
    uint64_t peerBirth=0;
    std::mutex mutex;std::thread worker;
    NSArray<NSNumber*>*overlays=@[];NSDictionary*catalogRequest=nil;bool hasOverlays=false;
    double previousLoss=0;
    void onMain(void(^operation)(Impl&)){
        std::weak_ptr<Impl>weak=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{if(auto self=weak.lock())if(!self->stopped)operation(*self);});
    }
    bool applyMainEvents(){
        // Geometry travels before its frame in the Mach queue. Wait until its
        // main-queue callback has applied it before invoking a frame callback.
        // The bounded waits also let main-thread stop() join this thread.
        auto applied=dispatch_semaphore_create(0);dispatch_async(dispatch_get_main_queue(),^{dispatch_semaphore_signal(applied);});
        while(!stopped)if(dispatch_semaphore_wait(applied,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_MSEC))==0)return true;
        return false;
    }
    bool control(NSDictionary*request){std::lock_guard guard(mutex);return !stopped&&remote&&send(remote,Control,0,{},MACH_PORT_NULL,request);}
    void clearPeer(){std::lock_guard guard(mutex);if(remote)mach_port_deallocate(mach_task_self(),remote);remote=MACH_PORT_NULL;process=0;}
    bool attach(){
        const auto deadline=now()+5;double lastSpawn=0;
        while(!stopped&&now()<deadline){
            NSDictionary*record=readRendezvous(path);NSString*name=record[@"name"];NSNumber*recordPID=record[@"pid"];const auto candidate=[recordPID isKindOfClass:NSNumber.class]?recordPID.intValue:0;
            if([name isKindOfClass:NSString.class]&&[name hasPrefix:[identifier stringByAppendingString:@"."]]&&name.length<BOOTSTRAP_MAX_NAME_LEN&&sameExecutable(candidate)){
                mach_port_t peer=MACH_PORT_NULL;
                if(bootstrap_look_up(bootstrap_port,const_cast<char*>(name.UTF8String),&peer)==KERN_SUCCESS){
                    if(send(peer,Hello,0,{},local,@{@"role":role})){
                        const auto helloDeadline=now()+1;
                        while(!stopped&&now()<helloDeadline){Received packet;const auto status=receive(local,100,packet,candidate);
                            if(status==MACH_RCV_TIMED_OUT||status==MACH_RCV_INVALID_DATA)continue;
                            if(status!=KERN_SUCCESS)break;
                            if(packet.deadName){if(packet.deadPort!=peer)continue;break;}
                            if(packet.message.command==Goodbye)break;
                            NSDictionary*json=status==KERN_SUCCESS&&!packet.deadName?jsonObject(packet):nil;
                            if(packet.message.command==Welcome&&[json[@"service"] isKindOfClass:NSNumber.class]&&[json[@"service"] intValue]==candidate){
                                {std::lock_guard guard(mutex);remote=peer;process=candidate;peerBirth=processBirth(candidate);watchDeadName(peer,local);
                                    if(hasOverlays)send(peer,Control,0,{},MACH_PORT_NULL,@{@"overlays":overlays});
                                    if(catalogRequest)send(peer,Control,0,{},MACH_PORT_NULL,@{@"catalog":catalogRequest});
                                }
                                onMain(^(Impl&self){if(self.callbacks.connected)self.callbacks.connected();});return true;
                            }
                        }
                    }
                    mach_port_deallocate(mach_task_self(),peer);
                }
            }
            if(now()-lastSpawn>=1){launchService(identifier);lastSpawn=now();}
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        return false;
    }
    void listen(){
        while(!stopped){
            if(!attach()){
                if(!stopped)onMain(^(Impl&self){if(self.callbacks.failed)self.callbacks.failed(@"Window capture stopped unexpectedly");});return;
            }
            double heartbeat=now();NSString*reason=@"Window capture stopped unexpectedly";bool pendingMainEvents=true;
            while(!stopped){
                Received packet;const auto status=receive(local,100,packet,process.load());
                if(status==MACH_RCV_TIMED_OUT||status==MACH_RCV_INVALID_DATA){if(now()-heartbeat<5)continue;const auto lost=process.load();if(peerBirth&&processBirth(lost)==peerBirth&&sameExecutable(lost))kill(lost,SIGKILL);break;}
                if(status!=KERN_SUCCESS)break;
                if(packet.deadName){std::lock_guard guard(mutex);if(packet.deadPort!=remote)continue;break;}
                const auto&message=packet.message;
                if(message.command==Heartbeat){heartbeat=now();continue;}
                if(message.command==Frame){
                    if(pendingMainEvents&&!applyMainEvents())break;pendingMainEvents=false;
                    IOSurfaceRef surface=IOSurfaceLookupFromMachPort(message.port.name);
                    if(surface){if(callbacks.frame)callbacks.frame(callbacks.frameContext,message.feed,surface,message.frame);else release(message.feed,message.frame.sequence);CFRelease(surface);}
                    else release(message.feed,message.frame.sequence);
                    continue;
                }
                NSDictionary*event=jsonObject(packet);
                if(message.command==Goodbye){if([event[@"reason"] isKindOfClass:NSString.class])reason=event[@"reason"];break;}
                if(message.command!=Event||!event)continue;
                const auto feed=message.feed;
                pendingMainEvents=true;
                onMain(^(Impl&self){
                    NSString*kind=event[@"event"];
                    if(![kind isKindOfClass:NSString.class])return;
                    if(!feed&&![kind isEqualToString:@"excluded"]){if(self.callbacks.catalogEvent)self.callbacks.catalogEvent(event);}
                    else if(self.callbacks.feedEvent)self.callbacks.feedEvent(feed,event);
                });
            }
            clearPeer();if(stopped)return;
            const auto lostAt=now();const bool exhausted=previousLoss&&lostAt-previousLoss<10;previousLoss=lostAt;
            onMain(^(Impl&self){if(self.callbacks.disconnected)self.callbacks.disconnected(reason);});
            if(exhausted){onMain(^(Impl&self){if(self.callbacks.failed)self.callbacks.failed(@"Window capture stopped unexpectedly");});return;}
        }
    }
    void release(uint32_t feed,uint64_t sequence){std::lock_guard guard(mutex);if(!stopped&&remote){FrameInfo frame{};frame.sequence=sequence;send(remote,Release,feed,frame);}}
    void stop(){
        if(!stopped.exchange(true)){std::lock_guard guard(mutex);if(remote)send(remote,Goodbye,0,{},MACH_PORT_NULL,@{@"reason":@"Client stopped"});}
        if(worker.joinable()){if(worker.get_id()==std::this_thread::get_id())worker.detach();else worker.join();}
        clearPeer();if(local){mach_port_destroy(mach_task_self(),local);local=MACH_PORT_NULL;}
    }
    ~Impl(){stop();}
};

std::shared_ptr<Client>Client::connect(NSString*serviceId,NSString*role,ClientCallbacks callbacks,NSString**error){
    NSString*identifier=serviceId.length?serviceId:defaultServiceId();NSString*path=rendezvousPath(identifier);
    if(!path||![@[@"chain",@"catalog"] containsObject:role]){if(error)*error=@"The window capture service address is invalid";return {};}
    auto impl=std::make_shared<Impl>();impl->identifier=[identifier copy];impl->path=path;impl->role=[role copy];impl->callbacks=callbacks;impl->local=receiver();
    if(!impl->local){if(error)*error=@"The window capture connection could not be created";return {};}
    auto client=std::shared_ptr<Client>(new Client);client->implementation=impl;impl->worker=std::thread([impl]{@autoreleasepool{impl->listen();}});return client;
}
void Client::setOverlays(NSArray<NSNumber*>*windowIDs){auto self=implementation;if(!self)return;NSArray*copied=[windowIDs copy]?:@[];{std::lock_guard guard(self->mutex);self->overlays=copied;self->hasOverlays=true;}self->control(@{@"overlays":copied});}
void Client::open(uint32_t feed,NSDictionary*request){if(!implementation||!feed)return;NSMutableDictionary*value=[request mutableCopy]?:[NSMutableDictionary dictionary];value[@"feed"]=@(feed);implementation->control(@{@"open":value});}
void Client::options(uint32_t feed,NSDictionary*options){if(!implementation||!feed)return;NSMutableDictionary*value=[options mutableCopy]?:[NSMutableDictionary dictionary];value[@"feed"]=@(feed);implementation->control(@{@"options":value});}
void Client::close(uint32_t feed){if(implementation)implementation->control(@{@"close":@{@"feed":@(feed)}});}
void Client::release(uint32_t feed,uint64_t sequence){if(implementation)implementation->release(feed,sequence);}
void Client::catalog(NSDictionary*request){auto self=implementation;if(!self)return;{std::lock_guard guard(self->mutex);self->catalogRequest=[request copy];}self->control(@{@"catalog":request?:@NO});}
void Client::stop(){if(implementation)implementation->stop();}
pid_t Client::servicePid()const{return implementation?implementation->process.load():0;}
Client::~Client(){stop();}
}

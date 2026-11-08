#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <mach/mach.h>
#include <mach/notify.h>
#include <bsm/libbsm.h>
#include <cstdint>
#include <cstring>
#include <unistd.h>

#ifdef __OBJC__
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <limits.h>
#endif

namespace macfx::wcap {
constexpr uint32_t Version=2;
enum Command:uint32_t {Hello=1,Welcome=2,Control=3,Event=4,Frame=5,Release=6,Heartbeat=7,Goodbye=8};
struct FrameInfo {uint64_t sequence=0,generation=0;double time=0;uint32_t width=0,height=0;uint32_t cropX=0,cropY=0,cropWidth=0,cropHeight=0;double contentScale=1,scaleFactor=1;};
// Every protocol message has the same two descriptors, including empty ones.
struct Message {
    mach_msg_header_t header{};mach_msg_body_t body{};
    mach_msg_port_descriptor_t port{};
    mach_msg_ool_descriptor_t json{};
    uint32_t version=Version,command=0,feed=0,reserved=0;int32_t process=0;FrameInfo frame{};
};
struct Received {
    Message message{};pid_t auditProcess=0;bool deadName=false;mach_port_t deadPort=MACH_PORT_NULL;
    Received()=default;
    Received(const Received&)=delete;
    Received&operator=(const Received&)=delete;
    void reset(){if(message.header.msgh_size)mach_msg_destroy(&message.header);message={};auditProcess=0;deadName=false;deadPort=MACH_PORT_NULL;}
    ~Received(){reset();}
};
inline mach_port_t receiver(){
    mach_port_t port=MACH_PORT_NULL;
    if(mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&port)!=KERN_SUCCESS)return MACH_PORT_NULL;
    mach_port_limits_t limits{};limits.mpl_qlimit=64;
    if(mach_port_set_attributes(mach_task_self(),port,MACH_PORT_LIMITS_INFO,reinterpret_cast<mach_port_info_t>(&limits),MACH_PORT_LIMITS_INFO_COUNT)!=KERN_SUCCESS||
       mach_port_insert_right(mach_task_self(),port,port,MACH_MSG_TYPE_MAKE_SEND)!=KERN_SUCCESS){mach_port_destroy(mach_task_self(),port);return MACH_PORT_NULL;}
    return port;
}
inline bool watchDeadName(mach_port_t peer,mach_port_t local){
    mach_port_t previous=MACH_PORT_NULL;
    const auto result=mach_port_request_notification(mach_task_self(),peer,MACH_NOTIFY_DEAD_NAME,0,local,MACH_MSG_TYPE_MAKE_SEND_ONCE,&previous);
    if(previous)mach_port_deallocate(mach_task_self(),previous);
    return result==KERN_SUCCESS;
}
inline kern_return_t receive(mach_port_t local,unsigned timeoutMS,Received&result,pid_t expectedProcess=0){
    result.reset();
    union Buffer {struct {Message message;mach_msg_max_trailer_t trailer;} packet;struct {mach_dead_name_notification_t notice;mach_msg_max_trailer_t trailer;} dead;Buffer(){std::memset(this,0,sizeof(*this));}} buffer;
    auto*header=&buffer.packet.message.header;
    const auto status=mach_msg(header,MACH_RCV_MSG|MACH_RCV_TIMEOUT|MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)|MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),0,sizeof(buffer),local,timeoutMS,MACH_PORT_NULL);
    if(status!=KERN_SUCCESS){
        // A body error can leave the descriptors that did arrive owned by
        // this envelope even though another descriptor could not be copied.
        if((status&~MACH_MSG_MASK)==MACH_RCV_BODY_ERROR)mach_msg_destroy(header);
        return status;
    }
    if(header->msgh_id==MACH_NOTIFY_DEAD_NAME&&header->msgh_size==sizeof(mach_dead_name_notification_t)&&!(header->msgh_bits&MACH_MSGH_BITS_COMPLEX)){
        const auto*trailer=reinterpret_cast<const mach_msg_audit_trailer_t*>(reinterpret_cast<const uint8_t*>(&buffer)+round_msg(header->msgh_size));
        if(trailer->msgh_trailer_type!=MACH_MSG_TRAILER_FORMAT_0||trailer->msgh_trailer_size<sizeof(*trailer)||trailer->msgh_audit.val[5]!=0){mach_msg_destroy(header);return MACH_RCV_INVALID_DATA;}
        result.deadName=true;result.deadPort=buffer.dead.notice.not_port;
        // The notification gives the receiver one additional dead-name right.
        if(result.deadPort)mach_port_deallocate(mach_task_self(),result.deadPort);
        return KERN_SUCCESS;
    }
    const auto invalid=[&](){mach_msg_destroy(header);return MACH_RCV_INVALID_DATA;};
    if(header->msgh_size!=sizeof(Message)||!(header->msgh_bits&MACH_MSGH_BITS_COMPLEX)||buffer.packet.message.body.msgh_descriptor_count!=2)return invalid();
    const auto&value=buffer.packet.message;
    if(value.version!=Version||value.command<Hello||value.command>Goodbye||value.reserved||value.port.type!=MACH_MSG_PORT_DESCRIPTOR||value.json.type!=MACH_MSG_OOL_DESCRIPTOR||value.json.size>1024*1024)return invalid();
    const auto*trailer=reinterpret_cast<const mach_msg_audit_trailer_t*>(reinterpret_cast<const uint8_t*>(&buffer)+round_msg(header->msgh_size));
    if(trailer->msgh_trailer_type!=MACH_MSG_TRAILER_FORMAT_0||trailer->msgh_trailer_size<sizeof(*trailer))return invalid();
    // audit_token_t's pid slot is part of Darwin's published audit-token ABI.
    const auto pid=static_cast<pid_t>(trailer->msgh_audit.val[5]);
    if(pid<=0||expectedProcess&&pid!=expectedProcess)return invalid();
    if((value.command==Hello||value.command==Frame)!=bool(value.port.name)||value.command!=Hello&&value.command!=Frame&&value.port.name)return invalid();
    if(value.json.size&&!value.json.address)return invalid();
    result.message=value;result.auditProcess=pid;return KERN_SUCCESS;
}

#ifdef __OBJC__
inline NSDictionary*jsonObject(const Received&received){
    if(!received.message.json.size)return nil;
    NSData*bytes=[NSData dataWithBytesNoCopy:received.message.json.address length:received.message.json.size freeWhenDone:NO];
    id object=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
    return [object isKindOfClass:NSDictionary.class]?object:nil;
}
inline bool send(mach_port_t destination,Command command,uint32_t feed=0,const FrameInfo&frame={},mach_port_t port=MACH_PORT_NULL,NSDictionary*json=nil){
    Message value{};
    value.header.msgh_bits=MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0)|MACH_MSGH_BITS_COMPLEX;
    value.header.msgh_remote_port=destination;value.header.msgh_size=sizeof(value);
    value.body.msgh_descriptor_count=2;
    value.port.name=port;value.port.disposition=command==Hello?MACH_MSG_TYPE_MAKE_SEND:MACH_MSG_TYPE_MOVE_SEND;value.port.type=MACH_MSG_PORT_DESCRIPTOR;
    value.json.type=MACH_MSG_OOL_DESCRIPTOR;value.json.copy=MACH_MSG_VIRTUAL_COPY;value.json.deallocate=TRUE;
    value.command=command;value.feed=feed;value.frame=frame;value.process=getpid();
    if(json){
        NSData*bytes=[NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
        vm_address_t memory=0;
        if(!bytes||bytes.length>1024*1024||vm_allocate(mach_task_self(),&memory,bytes.length,VM_FLAGS_ANYWHERE)!=KERN_SUCCESS){if(command==Frame&&port)mach_port_deallocate(mach_task_self(),port);return false;}
        std::memcpy(reinterpret_cast<void*>(memory),bytes.bytes,bytes.length);value.json.address=reinterpret_cast<void*>(memory);value.json.size=static_cast<mach_msg_size_t>(bytes.length);
    }
    const auto status=mach_msg(&value.header,MACH_SEND_MSG|MACH_SEND_TIMEOUT,sizeof(value),0,MACH_PORT_NULL,command==Frame?0:1000,MACH_PORT_NULL);
    if(status!=KERN_SUCCESS){
        // COPY_SEND and MAKE_SEND are borrowed; only the surface and allocated
        // OOL bytes belong to this outgoing envelope on a failed send.
        value.header.msgh_remote_port=MACH_PORT_NULL;
        if(command==Hello)value.port.name=MACH_PORT_NULL;
        mach_msg_destroy(&value.header);
    }
    return status==KERN_SUCCESS;
}
inline NSString*executablePath(){char path[PROC_PIDPATHINFO_MAXSIZE]{};return proc_pidpath(getpid(),path,sizeof(path))>0?@(path):nil;}
inline NSString*defaultServiceId(){return [NSString stringWithFormat:@"org.maclauncher.window-capture.%d",getppid()];}
inline NSString*rendezvousPath(NSString*identifier){
    if(!identifier.length||identifier.length>160||[identifier rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"] invertedSet]].location!=NSNotFound)return nil;
    char path[PATH_MAX]{};if(!confstr(_CS_DARWIN_USER_TEMP_DIR,path,sizeof(path)))return nil;
    return [@(path) stringByAppendingPathComponent:[identifier stringByAppendingString:@".lock"]];
}
#endif
}

#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "xess-protocol.h"
#include <mach/mach.h>
#include <bsm/libbsm.h>
#include <dlfcn.h>
#include <stdexcept>
namespace macfx::xess {
struct Wire {mach_msg_header_t header{};mach_msg_body_t body{};mach_msg_port_descriptor_t ports[3]{};MLXessCall call{};};
struct Reply {mach_msg_header_t header{};MLXessCall call{};};
inline mach_port_t receiver(){mach_port_t port=MACH_PORT_NULL;if(mach_port_allocate(mach_task_self(),MACH_PORT_RIGHT_RECEIVE,&port)!=KERN_SUCCESS||mach_port_insert_right(mach_task_self(),port,port,MACH_MSG_TYPE_MAKE_SEND)!=KERN_SUCCESS)throw std::runtime_error("Cannot create the XeSS GPU service endpoint");return port;}
template<typename T>int send(T &message,mach_port_t port){message.header.msgh_remote_port=port;message.header.msgh_size=sizeof(T);message.header.msgh_bits=MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND,0)|(message.header.msgh_bits&MACH_MSGH_BITS_COMPLEX);return mach_msg(&message.header,MACH_SEND_MSG|MACH_SEND_TIMEOUT,sizeof(T),0,MACH_PORT_NULL,1000,MACH_PORT_NULL);}
template<typename T>int receive(T &message,mach_port_t port,unsigned timeout,pid_t expected=0,pid_t *actual=nullptr){
    struct {T value;mach_msg_max_trailer_t trailer;} buffer{};
    auto result=mach_msg(&buffer.value.header,MACH_RCV_MSG|MACH_RCV_TIMEOUT|MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0)|MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),0,sizeof(buffer),port,timeout,MACH_PORT_NULL);
    if(result==KERN_SUCCESS){
        if(buffer.value.header.msgh_size!=sizeof(T)){mach_msg_destroy(&buffer.value.header);return MACH_RCV_INVALID_DATA;}
        using AuditPID=pid_t(*)(audit_token_t);static const auto auditPID=reinterpret_cast<AuditPID>(dlsym(dlopen("/usr/lib/libbsm.dylib",RTLD_LOCAL|RTLD_NOW),"audit_token_to_pid"));
        const auto *trailer=reinterpret_cast<const mach_msg_audit_trailer_t*>(reinterpret_cast<const uint8_t*>(&buffer)+round_msg(sizeof(T)));
        if(!auditPID||trailer->msgh_trailer_size<sizeof(*trailer)){mach_msg_destroy(&buffer.value.header);return MACH_RCV_INVALID_DATA;}
        const auto pid=auditPID(trailer->msgh_audit);if(expected&&pid!=expected){mach_msg_destroy(&buffer.value.header);return MACH_RCV_INVALID_DATA;}
        if(actual)*actual=pid;message=buffer.value;
    }
    return result;
}
inline void release(Wire &wire){if(!(wire.header.msgh_bits&MACH_MSGH_BITS_COMPLEX)||wire.body.msgh_descriptor_count>3)return;for(unsigned i=0;i<wire.body.msgh_descriptor_count;++i){auto &port=wire.ports[i];if(port.type==MACH_MSG_PORT_DESCRIPTOR&&port.name){mach_port_deallocate(mach_task_self(),port.name);port.name=MACH_PORT_NULL;}}}
inline void right(mach_msg_port_descriptor_t &entry,mach_port_t port){entry.name=port;entry.disposition=MACH_MSG_TYPE_COPY_SEND;entry.type=MACH_MSG_PORT_DESCRIPTOR;}
}

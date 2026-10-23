#include <binder/Binder.h>
#include <binder/IPCThreadState.h>
#include <binder/Parcel.h>
#include <binder/RpcServer.h>
#include <binder/RpcSession.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include "ParcelTransport.h"

using namespace android;
namespace {
constexpr pid_t callerPid=12345;
constexpr uid_t callerUid=10432;
constexpr char callerSid[]="u:r:untrusted_app:s0:c42";
class Endpoint final:public BBinder {
    status_t onTransact(uint32_t code,const Parcel& input,Parcel* reply,uint32_t)override {
        auto* thread=IPCThreadState::self();
        auto pid=thread->getCallingPid();auto uid=thread->getCallingUid();
        const char* sid=thread->getCallingSid();
        assert(reply->writeInt32(pid)==OK&&reply->writeInt32(uid)==OK);
        assert(reply->writeUtf8AsUtf16(std::string(sid?sid:""))==OK);
        auto identity=thread->clearCallingIdentity();
        assert(thread->getCallingPid()==getpid()&&thread->getCallingUid()==getuid());
        thread->restoreCallingIdentity(identity);
        assert(thread->getCallingPid()==pid&&thread->getCallingUid()==uid);
        if(code==1){
            auto callback=input.readStrongBinder();assert(callback);
            Parcel request,response;request.markForBinder(callback);
            assert(callback->transact(2,request,&response)==OK);
            assert(response.readInt32()==pid&&static_cast<uid_t>(response.readInt32())==uid);
            assert(thread->getCallingPid()==pid&&thread->getCallingUid()==uid);
        }
        return OK;
    }
};
void run(){
    int sockets[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)==0);
    auto server=RpcServer::make();server->setMaxThreads(2);
    server->setSupportedFileDescriptorTransportModes({RpcSession::FileDescriptorTransportMode::UNIX});
    server->setPerSessionRootObject([root=sp<Endpoint>::make()](wp<RpcSession> weak,const void*,size_t)->sp<IBinder>{
        weak.promote()->setHostLocalBridge();return root;
    });
    assert(server->setupUnixDomainSocketBootstrapServer(binder::unique_fd(sockets[0]))==OK);server->start();
    auto session=RpcSession::make();session->setMaxIncomingThreads(2);
    session->setHostLocalBridge();
    session->setFileDescriptorTransportMode(RpcSession::FileDescriptorTransportMode::UNIX);
    assert(session->setupUnixDomainSocketBootstrapClient(binder::unique_fd(sockets[1]))==OK);
    auto remote=session->getRootObject();assert(remote);
    auto* thread=IPCThreadState::self();auto previousPid=thread->getCallingPid();auto previousUid=thread->getCallingUid();
    Parcel request,response;request.markForBinder(remote);request.writeStrongBinder(sp<Endpoint>::make());
    assert(thread->transactRpcWithIdentity(callerPid,callerUid,callerSid,remote,1,request,&response,0)==OK);
    assert(response.readInt32()==callerPid);
    assert(static_cast<uid_t>(response.readInt32())==callerUid);
    std::string sid;assert(response.readUtf8FromUtf16(&sid)==OK);
    assert(sid==callerSid);
    assert(thread->getCallingPid()==previousPid&&thread->getCallingUid()==previousUid);
    remote.clear();assert(session->shutdownAndWait(true));assert(server->shutdown());
}
void untrusted(){
    // Identical wire bytes retain no authority on an ordinary process session.
    // Construct the envelope using the actual current transport format.
    auto session=RpcSession::make();
    Parcel wire,decoded;wire.markForRpc(session);
    wire.writeInt32(2);wire.writeInt32(callerPid);wire.writeUint32(callerUid);
    wire.writeBool(true);wire.writeUtf8AsUtf16(std::string(callerSid));
    wire.writeByteVector(std::vector<uint8_t>{});wire.writeUint64(0);wire.setDataPosition(0);
    HostParcelTransport::Caller caller;
    assert(HostParcelTransport::decode(wire,&decoded,&caller)==OK);
    assert(!caller.trusted&&caller.pid==callerPid&&caller.uid==callerUid);
}
}
int main(){run();untrusted();puts("PASS private ABI caller identity, nested callbacks, clear/restore and untrusted envelope rejection");}

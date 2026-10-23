#include <binder/Binder.h>
#include <binder/Parcel.h>
#include <binder/RpcServer.h>
#include <binder/RpcSession.h>
#include <utils/Errors.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>
#include <signal.h>

using namespace android;
using binder::unique_fd;
static std::atomic<int> callbacks;

class ConcurrentCallback final : public BBinder {
    std::mutex mutex;
    std::condition_variable changed;
    unsigned entered=0;
    status_t onTransact(uint32_t code,const Parcel&,Parcel*,uint32_t) override {
        assert(code==8);
        std::unique_lock lock(mutex);
        ++entered;changed.notify_all();
        // Three separate incoming workers must reach this barrier. A nested
        // callback on the calling thread cannot satisfy it.
        assert(changed.wait_for(lock,std::chrono::seconds(3),[&]{return entered==3;}));
        return OK;
    }
};

class Callback final : public BBinder {
    status_t onTransact(uint32_t code,const Parcel& data,Parcel* reply,uint32_t) override {
        assert(code==7 && data.readInt32()==42);
        callbacks++;
        return reply->writeInt32(getpid());
    }
};

class Service final : public BBinder {
public:
    unique_fd retained;
    status_t onTransact(uint32_t code,const Parcel& data,Parcel* reply,uint32_t) override {
        if(code==1){
            auto callback=data.readStrongBinder();
            assert(callback);
            int fd=data.readFileDescriptor();
            assert(fd>=0 && (fcntl(fd,F_GETFD)&FD_CLOEXEC));
            retained.reset(fcntl(fd,F_DUPFD_CLOEXEC,0));
            assert(retained.ok());
            Parcel request,response;
            request.markForBinder(callback);
            assert(request.writeInt32(42)==OK);
            assert(callback->transact(7,request,&response)==OK);
            assert(reply->writeInt32(response.readInt32())==OK);
            return reply->writeInt32(getpid());
        }
        if(code==2){
            char value[16]{};
            assert(pread(retained.get(),value,8,0)==8 && !memcmp(value,"retained",8));
            return reply->writeFileDescriptor(retained.get());
        }
        if(code==3){
            retained.reset();
            return OK;
        }
        if(code==4){
            auto callback=data.readStrongBinder();
            int fd=data.readFileDescriptor();char value=0;
            assert(read(fd,&value,1)==1 && value=='x');
            assert(write(fd,&value,1)==1);
            Parcel request,response;request.markForBinder(callback);
            request.writeInt32(42);
            return callback->transact(7,request,&response);
        }
        if(code==5){
            auto callback=data.readStrongBinder();
            std::vector<std::thread> workers;
            for(unsigned i=0;i<3;++i)workers.emplace_back([callback]{
                Parcel request,response;request.markForBinder(callback);
                assert(callback->transact(8,request,&response)==OK);
            });
            for(auto& worker:workers)worker.join();
            return OK;
        }
        return UNKNOWN_TRANSACTION;
    }
};

int main(int argc,char** argv){
    if(argc==4 && !strcmp(argv[1],"server")){
        auto service=sp<Service>::make();
        auto server=RpcServer::make();
        server->setMaxThreads(2);
        server->setSupportedFileDescriptorTransportModes({RpcSession::FileDescriptorTransportMode::UNIX});
        server->setRootObject(service);
        assert(server->setupUnixDomainSocketBootstrapServer(unique_fd(atoi(argv[2])))==OK);
        // The sender may establish its bootstrap before this process has been
        // scheduled. Queued SCM_RIGHTS must survive until actual receipt.
        usleep(300000);
        server->start();
        char stop;assert(read(atoi(argv[3]),&stop,1)==1);close(atoi(argv[3]));
        assert(server->shutdown());
        return 0;
    }
    assert(argc==1);
    int sockets[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,sockets)==0);
    int stopped[2];assert(pipe(stopped)==0);
    pid_t child=fork();assert(child>=0);
    if(child==0){close(sockets[0]);close(stopped[1]);char descriptor[24],stop[24];snprintf(descriptor,sizeof descriptor,"%d",sockets[1]);snprintf(stop,sizeof stop,"%d",stopped[0]);execl(argv[0],argv[0],"server",descriptor,stop,nullptr);_exit(127);}
    close(sockets[1]);close(stopped[0]);
    auto session=RpcSession::make();
    session->setMaxIncomingThreads(1);
    session->setFileDescriptorTransportMode(RpcSession::FileDescriptorTransportMode::UNIX);
    assert(session->setupUnixDomainSocketBootstrapClient(unique_fd(sockets[0]))==OK);
    auto remote=session->getRootObject();assert(remote);
    assert(session->getMaxIncomingThreads()==1);
    assert(session->growIncomingThreadPool(3)==OK);
    assert(session->growIncomingThreadPool(3)==OK);
    assert(session->getMaxIncomingThreads()==3);
    {
        Parcel request,response;request.markForBinder(remote);
        assert(request.writeStrongBinder(sp<ConcurrentCallback>::make())==OK);
        assert(remote->transact(5,request,&response)==OK);
    }
    char filename[]="/private/tmp/maclauncher-binder-fd-XXXXXX";
    unique_fd source(mkstemp(filename));assert(source.ok());assert(unlink(filename)==0);
    assert(write(source.get(),"retained",8)==8);
    {
        Parcel request,response;
        request.markForBinder(remote);
        assert(request.writeStrongBinder(sp<Callback>::make())==OK);
        assert(request.writeFileDescriptor(source.get())==OK);
        assert(remote->transact(1,request,&response)==OK);
        assert(response.readInt32()==getpid());
        assert(response.readInt32()==child);
    }
    source.reset();
    unique_fd returned;
    {
        Parcel request,response;request.markForBinder(remote);
        assert(remote->transact(2,request,&response)==OK);
        int fd=response.readFileDescriptor();
        assert(fd>=0 && (fcntl(fd,F_GETFD)&FD_CLOEXEC));
        returned.reset(fcntl(fd,F_DUPFD_CLOEXEC,0));
        assert(returned.ok());
    }
    {
        Parcel request,response;request.markForBinder(remote);
        assert(remote->transact(3,request,&response)==OK);
    }
    // A one-way Parcel may retire before the receiving process runs at all.
    // Preserve socket ownership across the queued native descriptor envelope.
    assert(kill(child,SIGSTOP)==0);int paused=0;
    assert(waitpid(child,&paused,WUNTRACED)==child && WIFSTOPPED(paused));
    int payload[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,payload)==0);
    assert(write(payload[0],"x",1)==1);
    {
        Parcel request;request.markForBinder(remote);
        request.writeStrongBinder(sp<Callback>::make());
        request.writeFileDescriptor(payload[1],true);
        assert(remote->transact(4,request,nullptr,IBinder::FLAG_ONEWAY)==OK);
    }
    assert(kill(child,SIGCONT)==0);
    for(int i=0;i<200 && callbacks.load()!=2;i++)usleep(5000);
    assert(callbacks.load()==2);char echoed=0;
    assert(read(payload[0],&echoed,1)==1 && echoed=='x');close(payload[0]);
    assert(write(stopped[1],"x",1)==1);close(stopped[1]);
    remote.clear();
    assert(session->shutdownAndWait(true));
    int status=0;assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
    char value[16]{};
    assert(pread(returned.get(),value,8,0)==8 && !memcmp(value,"retained",8));
    puts("PASS AOSP Binder RPC: separate processes, callback, transferred FD lifetime and shutdown");
}

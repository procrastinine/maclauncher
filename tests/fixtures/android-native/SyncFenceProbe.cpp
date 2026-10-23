#include <ui/Fence.h>
#include <cassert>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>

int main(){
    using android::Fence;using android::sp;
    auto empty=sp<Fence>::make();
    assert(!empty->isValid()&&empty->wait(0)==0&&empty->getSignalTime()==Fence::SIGNAL_TIME_INVALID);
    assert(Fence::merge("empty",empty,Fence::NO_FENCE)==Fence::NO_FENCE);
    int pipefd[2];assert(pipe(pipefd)==0);
    auto fence=sp<Fence>::make(pipefd[0]);
    assert(fence->isValid()&&fence->getFdCount()==1&&fence->wait(0)==-ETIME);
    unsigned char storage[4];void* buffer=storage;size_t size=sizeof(storage);int descriptor=-1;int* descriptors=&descriptor;size_t count=1;
    assert(fence->flatten(buffer,size,descriptors,count)==0&&size==0&&count==0&&descriptor==pipefd[0]);
    int duplicate=fence->dup();assert(duplicate>=0);
    auto restored=sp<Fence>::make();const void* input=storage;const int* fds=&duplicate;size=sizeof(storage);count=1;
    assert(restored->unflatten(input,size,fds,count)==0&&restored->get()==duplicate&&restored->wait(0)==-ETIME);
    assert(write(pipefd[1],"x",1)==1&&fence->wait(0)==0&&restored->waitForever("fixture")==0);
    assert(fence->getSignalTime()==Fence::SIGNAL_TIME_INVALID);
    restored.clear();assert(fcntl(duplicate,F_GETFD)==-1&&errno==EBADF);
    fence.clear();assert(fcntl(pipefd[0],F_GETFD)==-1&&errno==EBADF);close(pipefd[1]);
    std::puts("PASS original Fence: real wait, flatten/unflatten, merge, descriptor duplication and last-reference closure");
}

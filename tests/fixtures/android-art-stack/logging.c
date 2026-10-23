#include <android/log.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(void){
    int redirected[2];assert(!pipe(redirected));assert(dup2(redirected[1],2)==2);close(redirected[1]);
    assert(__android_log_write(ANDROID_LOG_INFO,"Probe","independent Android log")>=0);
    assert(!fcntl(redirected[0],F_SETFL,O_NONBLOCK));
    char bytes[64];assert(read(redirected[0],bytes,sizeof bytes)==-1&&errno==EAGAIN);
    assert(write(2,"guest-stderr",12)==12);assert(read(redirected[0],bytes,sizeof bytes)==12);
    assert(!memcmp(bytes,"guest-stderr",12));close(2);
    assert(__android_log_print(ANDROID_LOG_INFO,"Probe","after close %d",42)>=0);
    close(redirected[0]);puts("PASS original Bionic redirects stderr while original liblog retains its physical output");
}

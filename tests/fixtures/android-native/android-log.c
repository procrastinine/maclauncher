#include "android-log.h"
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static ssize_t receive(int fd,char *bytes,size_t size){
    struct pollfd p={.fd=fd,.events=POLLIN};assert(poll(&p,1,1000)>0);
    return read(fd,bytes,size);
}
int main(void){
    int output[2],redirected[2];assert(!pipe(output)&&!pipe(redirected));
    assert(dup2(output[1],2)==2);close(output[1]);
    klj_android_log_initialize();
    assert(dup2(redirected[1],2)==2);close(redirected[1]);
    assert(write(2,"guest-stderr",12)==12);
    errno=EDOM;assert(klj_android_log_write(4,"Go","captured once")>0);assert(errno==EDOM);
    char bytes[256]={0};assert(receive(redirected[0],bytes,sizeof bytes)==12);assert(!strcmp(bytes,"guest-stderr"));
    memset(bytes,0,sizeof bytes);assert(receive(output[0],bytes,sizeof bytes)>0);assert(!strcmp(bytes,"[4/Go] captured once\n"));
    struct pollfd p={.fd=redirected[0],.events=POLLIN};assert(poll(&p,1,20)==0);
    // A game's fclose(stderr) likewise leaves Android logging operational.
    assert(!fclose(stderr));assert(klj_android_log_write(6,"Native","after close")>0);
    memset(bytes,0,sizeof bytes);assert(receive(output[0],bytes,sizeof bytes)>0);assert(!strcmp(bytes,"[6/Native] after close\n"));
    close(output[0]);close(redirected[0]);puts("PASS Android logging survives guest stdio redirection and closure without feedback");
}

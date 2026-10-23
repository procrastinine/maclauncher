#include <android/log.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// Original Android entry points, descriptor calls and variadic ABI run through
// the delivered guest loader. The physical logger is initialized before entry.
int NativeLogProbe(void){
    int redirected[2];if(pipe(redirected))return 1;
    if(dup2(redirected[1],1)!=1||dup2(redirected[1],2)!=2)return 2;
    close(redirected[1]);
    if(write(1,"guest-out",9)!=9||write(2,"guest-err",9)!=9)return 3;
    if(__android_log_write(4,"NativeWrite","after redirect")<0)return 4;
    if(__android_log_print(5,"NativePrint","number %d %s",42,"works")<0)return 5;
    char bytes[64]={0};if(read(redirected[0],bytes,sizeof bytes)!=18||strcmp(bytes,"guest-outguest-err"))return 6;
    struct pollfd p={.fd=redirected[0],.events=POLLIN};if(poll(&p,1,20)!=0)return 7;
    if(fclose(stdout)||fclose(stderr))return 8;
    if(__android_log_write(6,"NativeWrite","after close")<0)return 9;
    if(__android_log_print(6,"NativePrint","closed %d",2)<0)return 10;
    close(redirected[0]);return 0;
}

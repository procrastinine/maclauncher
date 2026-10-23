#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int formatted(char *out,size_t size,const char *format,...){
 va_list args;va_start(args,format);int result=vsnprintf(out,size,format,args);va_end(args);return result;
}
static int compare(const void *left,const void *right){return *(const int*)left-*(const int*)right;}
__attribute__((naked,noinline)) static long kernel(long number,long argument){
 __asm__ volatile("push {r7, lr}\nmov r7, r0\nmov r0, r1\nsvc #0\npop {r7, pc}");
}
int original_imports(void){
 if(kernel(20,0)!=getpid())return 12;
 errno=EINTR;if(kernel(6,-1)!=-EBADF||errno!=EINTR)return 13;
 const char *expected="-91:1.25:9223372036854775806:shared";
 char *text=malloc(256);if(!text)return 1;
 int count=snprintf(text,256,"%d:%.2f:%lld:%s",-91,1.25,9223372036854775806LL,"shared");
 if(count!=(int)strlen(expected)||strcmp(text,expected))return 2;
 if(formatted(text,256,"%d:%.2f:%lld:%s",-91,1.25,9223372036854775806LL,"shared")!=count||strcmp(text,expected))return 3;
 text=realloc(text,512);if(!text||strcmp(text,expected))return 4;
 int values[]={9,-3,1,0};qsort(values,4,sizeof(int),compare);
 const int sorted[]={-3,0,1,9};if(memcmp(values,sorted,sizeof values))return 5;
 int descriptor=open("/dev/null",O_RDONLY);if(descriptor<0)return 6;
 if(fcntl(descriptor,F_GETFD)<0||close(descriptor))return 7;
 errno=0;if(open("/this-file-does-not-exist",O_RDONLY)!=-1||errno!=ENOENT)return 8;
 void *region=mmap(0,8192,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 if(region==MAP_FAILED)return 9;
 memcpy(region,text,count+1);if(memcmp(region,text,count+1))return 10;
 if(mprotect(region,4096,PROT_READ)||munmap(region,4096)||munmap((char*)region+4096,4096))return 11;
 free(text);return 0;
}

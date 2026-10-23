#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zlib.h>
#include <jni.h>
#include <stdarg.h>
#define FN(name) __typeof__(&name) call_##name=name;assert(call_##name)
static void join(char *out,const char *a,const char *b){assert(snprintf(out,PATH_MAX,"%s/%s",a,b)>0);}
static int print(gzFile file,const char *format,...){va_list args;va_start(args,format);int result=gzvprintf(file,format,args);va_end(args);return result;}
JNIEXPORT void JNICALL Java_ZlibGuestProbe_files(JNIEnv *env,jclass type,jstring directory){
 (void)type;const char *input=(*env)->GetStringUTFChars(env,directory,NULL);assert(input);char canonical[PATH_MAX];assert(realpath(input,canonical));(*env)->ReleaseStringUTFChars(env,directory,input);const char *base=canonical;FN(gzopen);FN(gzdopen);FN(gzbuffer);FN(gzread);FN(gzwrite);FN(gzfread);FN(gzfwrite);FN(gzclose);FN(gzclose_r);FN(gzclose_w);FN(gzputs);FN(gzgets);FN(gzgetc);FN(gzputc);FN(gzungetc);FN(gzrewind);FN(gzseek);FN(gztell);FN(gzoffset);FN(gzeof);FN(gzerror);FN(gzclearerr);FN(gzflush);FN(gzsetparams);FN(gzdirect);
 char file[PATH_MAX];join(file,base,"sample.gz");gzFile g=call_gzopen(file,"wb6e");assert(g);assert(!call_gzbuffer(g,1024));assert(call_gzwrite(g,"header\n",7)==7);assert(call_gzfwrite("ABCD",2,2,g)==2);assert(call_gzputc(g,'\n')=='\n');assert(call_gzputs(g,"line\n")==5);assert(!call_gzsetparams(g,1,Z_FILTERED));
 assert(gzprintf(g,"%d %s %.2f\n",42,"guest",1.25)==14);
 assert(print(g,"%d %s %.1f\n",9,"direct",2.5)==13);assert(!call_gzflush(g,Z_SYNC_FLUSH));assert(!call_gzclose_w(g));
 const char*expected="header\nABCD\nline\n42 guest 1.25\n9 direct 2.5\n";char restored[256]={0};g=call_gzopen(file,"rb");assert(g&&!call_gzdirect(g));assert(call_gzgetc(g)=='h');assert(call_gzungetc('h',g)=='h');assert(call_gzgets(g,restored,sizeof restored)&&!strcmp(restored,"header\n"));assert(call_gztell(g)==7);assert(call_gzseek(g,0,SEEK_SET)==0);assert(call_gzfread(restored,1,sizeof restored,g)==strlen(expected));assert(!strcmp(restored,expected));assert(call_gzeof(g));int error;assert(call_gzerror(g,&error)&&error==Z_OK);call_gzclearerr(g);assert(!call_gzeof(g));assert(!call_gzrewind(g));assert(call_gzoffset(g)>=0);assert(!call_gzclose_r(g));
 int fd=open(file,O_RDONLY);assert(fd>=0);g=call_gzdopen(fd,"rb");assert(g&&call_gzread(g,restored,sizeof restored)==(int)strlen(expected));assert(!call_gzclose(g));assert(fcntl(fd,F_GETFD)==-1&&errno==EBADF);
 fd=open(file,O_RDONLY);assert(fd>=0&&!call_gzdopen(fd,"r+"));assert(fcntl(fd,F_GETFD)>=0&&!close(fd));
 char sparse[PATH_MAX];join(sparse,base,"sparse");fd=open(sparse,O_CREAT|O_RDWR,0600);assert(fd>=0);off_t end=INT64_C(0x100000011);assert(!ftruncate(fd,end)&&pwrite(fd,"Z",1,end-1)==1&&!close(fd));g=call_gzopen(sparse,"rb");assert(g&&call_gzdirect(g));assert(call_gzseek(g,end-1,SEEK_SET)==end-1&&call_gztell(g)==end-1&&call_gzgetc(g)=='Z');assert(!call_gzclose(g));
 puts("PASS original guest gzip, variadic arguments, descriptor ownership and 64-bit offsets");
}

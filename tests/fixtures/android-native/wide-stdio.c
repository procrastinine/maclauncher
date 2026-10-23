#include <assert.h>
#include <errno.h>
#include <locale.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wchar.h>
#include "kl_va.h"
extern void *klj_wide_stdio_lookup(const char *);
typedef uint64_t Quad __attribute__((vector_size(16)));

// Fixed signatures place the guest's GP/FP arguments in the AAPCS64 register
// banks. v-functions additionally exercise the real register-save descriptor.
static int run_buffer(wchar_t *out,size_t size,const wchar_t *format,uint64_t a,uint64_t b,uint64_t c,uint64_t d,uint64_t e){
 return ((int(*)(wchar_t*,size_t,const wchar_t*,uint64_t,uint64_t,uint64_t,uint64_t,uint64_t))klj_wide_stdio_lookup("swprintf"))(out,size,format,a,b,c,d,e);
}
static void check(void){
 wchar_t out[512];
 assert(run_buffer(out,512,L"%2$*1$d %3$ls %4$s",5,42,(uintptr_t)L"雪",(uintptr_t)"🌈",0)==9);
 assert(!wcscmp(out,L"   42 雪 🌈"));
 assert(run_buffer(out,512,L"%#b/%#x",10,255,0,0,0)==11);assert(!wcscmp(out,L"0b1010/0xff"));
 typedef int(*Floating)(wchar_t*,size_t,const wchar_t*,double,Quad);
 Quad precise={UINT64_C(0x1000),UINT64_C(0x3fff000000000000)};
 int result=((Floating)klj_wide_stdio_lookup("swprintf"))(out,512,L"%.2f %.35Lf",1.25,precise);
 assert(result==42);assert(!wcscmp(out,L"1.25 1.00000000000000000000000000000078886"));
 Quad subnormal={1,0};
 typedef int(*LongFloating)(wchar_t*,size_t,const wchar_t*,Quad);
 assert(((LongFloating)klj_wide_stdio_lookup("swprintf"))(out,512,L"%La",subnormal)>0);assert(wcsstr(out,L"p-16494")!=NULL);
 uint64_t gp[8]={0},stack[16]={0};unsigned char fp[128]={0};
 for(int index=0;index<8;index++)gp[index]=index+1;
 for(int index=0;index<16;index++)stack[index]=index+9;
 kl_va args={.stack=stack,.gr_top=gp+8,.vr_top=fp+128,.gr_offs=-64,.vr_offs=-128};
 assert(((int(*)(wchar_t*,size_t,const wchar_t*,kl_va*))klj_wide_stdio_lookup("vswprintf"))(out,512,L"%12$ld/%1$ld/%9$ld",&args)==6);assert(!wcscmp(out,L"12/1/9"));
 errno=0;assert(run_buffer(out,3,L"abcd",0,0,0,0,0)==-1&&errno==EOVERFLOW&&!wcscmp(out,L"ab"));
 errno=0;assert(run_buffer(out,0,L"",0,0,0,0,0)==-1&&errno==EINVAL);
 errno=0;assert(run_buffer(out,512,L"%lc",0xd800,0,0,0,0)==-1&&errno==EILSEQ);
 errno=EDOM;assert(run_buffer(out,512,L"%#m",0,0,0,0,0)==4&&!wcscmp(out,L"EDOM"));
 FILE *file=tmpfile();assert(file);
 assert(((int(*)(FILE*,const wchar_t*,long))klj_wide_stdio_lookup("fwprintf"))(file,L"value:%ld",17)==8);
 gp[0]=19;args=(kl_va){.stack=stack,.gr_top=gp+8,.vr_top=fp+128,.gr_offs=-64,.vr_offs=-128};
 assert(((int(*)(FILE*,const wchar_t*,kl_va*))klj_wide_stdio_lookup("vfwprintf"))(file,L"/%ld",&args)==3);
 rewind(file);assert(fgetws(out,512,file)&&!wcscmp(out,L"value:17/19"));fclose(file);
 file=fopen("/dev/null","r");assert(file);errno=0;
 assert(((int(*)(FILE*,const wchar_t*))klj_wide_stdio_lookup("fwprintf"))(file,L"")==-1&&errno==EBADF);fclose(file);
}
static void *worker(void *unused){(void)unused;for(int n=0;n<30;n++)check();return NULL;}
int main(void){
 assert(setlocale(LC_ALL,"en_US.UTF-8"));
 const char *names[]={"wprintf","fwprintf","swprintf","vwprintf","vfwprintf","vswprintf"};for(int n=0;n<6;n++)assert(klj_wide_stdio_lookup(names[n]));
 check();pthread_t workers[4];for(int n=0;n<4;n++)assert(!pthread_create(&workers[n],NULL,worker,NULL));for(int n=0;n<4;n++)assert(!pthread_join(workers[n],NULL));
 FILE *capture=tmpfile();assert(capture);int saved=dup(STDOUT_FILENO);assert(saved>=0);assert(dup2(fileno(capture),STDOUT_FILENO)>=0);
 assert(((int(*)(const wchar_t*,long))klj_wide_stdio_lookup("wprintf"))(L"%ld",23)==2);
 uint64_t gp[8]={29};unsigned char fp[128]={0};kl_va args={.gr_top=gp+8,.vr_top=fp+128,.gr_offs=-64,.vr_offs=-128};
 assert(((int(*)(const wchar_t*,kl_va*))klj_wide_stdio_lookup("vwprintf"))(L"/%ld",&args)==3);fflush(stdout);assert(dup2(saved,STDOUT_FILENO)>=0);close(saved);
 rewind(capture);char bytes[16]={0};assert(fread(bytes,1,15,capture)==5&&!strcmp(bytes,"23/29"));fclose(capture);
 fprintf(stderr,"PASS original Android wide printf: six APIs, positional/spilled args, Unicode, binary128, stream ownership and concurrency\n");
}

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <sys/stat.h>
#include <zlib.h>
#include "directory-bridge.h"
#include "guest-paths.h"
#include "kl_obbmap.h"
#define CHECK(x) assert(x)
/* The OBB fixture supplies only its stream boundary, not the descriptor owner. */
int klj_directory_descriptor_adopt(int fd){(void)fd;return 0;}
int klj_descriptor_release(int fd,int (*release)(void *),void *context){(void)fd;return release(context);}
static void join(char *out,size_t size,const char *a,const char *b){int n=snprintf(out,size,"%s/%s",a,b);CHECK(n>0&&(size_t)n<size);}
static void u16(FILE *file,uint16_t value){CHECK(fputc(value&255,file)!=EOF);CHECK(fputc(value>>8,file)!=EOF);}
static void u32(FILE *file,uint32_t value){u16(file,(uint16_t)value);u16(file,(uint16_t)(value>>16));}
static void archive(const char *path){
    const char *name="Content/Paks/virtual.pak",*data="virtual-data";
    uint16_t names=(uint16_t)strlen(name);uint32_t bytes=(uint32_t)strlen(data),crc=(uint32_t)crc32(0,(const Bytef*)data,bytes);
    FILE *file=fopen(path,"wb");CHECK(file);
    u32(file,0x04034b50);u16(file,20);u16(file,0);u16(file,0);u16(file,0);u16(file,0);
    u32(file,crc);u32(file,bytes);u32(file,bytes);u16(file,names);u16(file,0);
    CHECK(fwrite(name,1,names,file)==names);CHECK(fwrite(data,1,bytes,file)==bytes);
    uint32_t central=(uint32_t)ftell(file);
    u32(file,0x02014b50);u16(file,20);u16(file,20);u16(file,0);u16(file,0);u16(file,0);u16(file,0);
    u32(file,crc);u32(file,bytes);u32(file,bytes);u16(file,names);u16(file,0);u16(file,0);
    u16(file,0);u16(file,0);u32(file,0);u32(file,0);CHECK(fwrite(name,1,names,file)==names);
    uint32_t central_size=(uint32_t)ftell(file)-central;
    u32(file,0x06054b50);u16(file,0);u16(file,0);u16(file,1);u16(file,1);u32(file,central_size);u32(file,central);u16(file,0);
    CHECK(fclose(file)==0);
}

const char *kl_driver_target_name(void){return "directory-fixture";}
int kl_errno_to_linux(int error){return error;}
const char *kl_guest_path(const char *path,char *buffer,size_t size){const char *mapped=klj_mapped_guest_path(path,buffer,size);return mapped?mapped:path;}
#define KL_GUEST_PATH(p) char mapped[4096];const char *_p=kl_guest_path(p,mapped,sizeof mapped)
static void kl_fs_trace(const char *op,const char *p,const char *extra,int error){(void)op;(void)p;(void)extra;(void)error;}
#include "directory-callers.c"

static void positions(void *dir){
 klj_directory_rewind(dir);klj_dirent *first=klb_readdir(dir);CHECK(first);char initial[256];strcpy(initial,first->d_name);
 long position=klj_directory_tell(dir);CHECK(position>=0&&first->d_off>=0);
 klj_dirent *next=klb_readdir(dir);CHECK(next);char expected[256];strcpy(expected,next->d_name);
 klj_directory_seek(dir,position);next=klb_readdir(dir);CHECK(next&&!strcmp(next->d_name,expected));
 while(klb_readdir(dir)){}
 klj_directory_seek(dir,position);next=klb_readdir(dir);CHECK(next&&!strcmp(next->d_name,expected));
 klj_directory_rewind(dir);next=klb_readdir(dir);CHECK(next&&!strcmp(next->d_name,initial));
 klj_dirent copy,*result;CHECK(!klj_directory_read_r(dir,&copy,&result)&&result==&copy);CHECK(!strcmp(copy.d_name,expected));
 while(result){CHECK(!klj_directory_read_r(dir,&copy,&result));}
}
int main(int argc,char **argv){
 CHECK(argc==2);CHECK(!mkdir(argv[1],0700));
 char obb[1024],base[1024],zip[1024],directory[1024],real[1024];
 join(obb,sizeof obb,argv[1],"obb");join(base,sizeof base,argv[1],"game");CHECK(!mkdir(obb,0700)&&!mkdir(base,0700));
 join(zip,sizeof zip,obb,"fixture.obb");archive(zip);kl_obbmap_init(obb,base);
 join(directory,sizeof directory,base,"Content/Paks");join(real,sizeof real,directory,"real.txt");FILE *file=fopen(real,"w");CHECK(file);CHECK(fputs("real",file)>=0&&!fclose(file));
 void *a=klb_opendir(argv[1]),*b=klb_opendir(directory);CHECK(a&&b);
 klj_dirent *saved=klb_readdir(a);CHECK(saved);klj_dirent snapshot=*saved;while(klb_readdir(b)){}CHECK(!memcmp(saved,&snapshot,sizeof(snapshot)));
 positions(a);positions(b);
 int descriptor=klj_directory_descriptor(b);CHECK(descriptor>=0);struct stat actual,expected;CHECK(!fstat(descriptor,&actual)&&!stat(directory,&expected)&&actual.st_ino==expected.st_ino);
 CHECK(!klb_closedir(a)&&!klb_closedir(b));CHECK(fcntl(descriptor,F_GETFD)==-1&&errno==EBADF);
 void *held[128];for(unsigned i=0;i<128;++i){held[i]=klb_opendir(directory);CHECK(held[i]);}for(unsigned i=0;i<128;++i)CHECK(!klb_closedir(held[i]));
 int fd=open(argv[1],O_RDONLY|O_DIRECTORY);CHECK(fd>=0);void *adopted=klj_directory_fdopen(fd);CHECK(adopted&&klj_directory_descriptor(adopted)==fd);positions(adopted);CHECK(!klb_closedir(adopted));CHECK(fcntl(fd,F_GETFD)==-1&&errno==EBADF);
 CHECK(!unlink(real)&&!rmdir(directory));void *only=klb_opendir(directory);CHECK(only);klj_dirent *entry=klb_readdir(only);CHECK(entry&&!strcmp(entry->d_name,"virtual.pak"));CHECK(!klb_readdir(only));klj_directory_rewind(only);entry=klb_readdir(only);CHECK(entry&&!strcmp(entry->d_name,"virtual.pak"));CHECK(!klb_closedir(only));
 puts("PASS real/OBB directory positions, independent result lifetime, fd ownership and128 live streams");return 0;
}

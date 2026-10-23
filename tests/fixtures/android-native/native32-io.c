#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zlib.h>

typedef void *(*lookup_fn)(const char *);
typedef struct { uint64_t ino; int64_t off; uint16_t length; uint8_t type; char name[256]; } guest_dirent;
static unsigned checks;
#define CHECK(x) do { ++checks; if (!(x)) { fprintf(stderr,"FAIL line %d: %s (errno=%d)\n",__LINE__,#x,errno);exit(1); } } while(0)
#define ENTRY(variable, table, symbol, type) type variable=(type)table(symbol); CHECK(variable)
static void *library;
static void *exported(const char *name){void *result=dlsym(library,name);CHECK(result);return result;}
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
typedef int (*getpos_fn)(void*,int64_t*);
typedef int (*setpos_fn)(void*,const int64_t*);
typedef void *(*open_fn)(const char*,const char*);
typedef int (*close_fn)(void*);
typedef size_t (*read_fn)(void*,size_t,size_t,void*);
typedef int (*seek_fn)(void*,int64_t,int);
typedef void *(*opendir_fn)(const char*);
typedef guest_dirent *(*readdir_fn)(void*);
typedef int (*dirfd_fn)(void*);
typedef long (*round_fn)(double);
typedef long (*roundf_fn)(float);
typedef long long (*llround_fn)(double);
typedef long long (*llroundf_fn)(float);
typedef int (*sign_fn)(double);
typedef int (*signf_fn)(float);
typedef void (*roots_fn)(const char*,const char*);

int main(int argc,char **argv){
    alarm(10);CHECK(argc==3);CHECK(mkdir(argv[2],0700)==0);
    library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){fprintf(stderr,"%s\n",dlerror());return 1;}
    lookup_fn shim=(lookup_fn)exported("kl_shim_lookup");
    ENTRY(getpos,shim,"fgetpos",getpos_fn);ENTRY(setpos,shim,"fsetpos",setpos_fn);
    CHECK((void*)getpos==shim("fgetpos64"));CHECK((void*)setpos==shim("fsetpos64"));
    ENTRY(open_file,shim,"fopen",open_fn);ENTRY(close_file,shim,"fclose",close_fn);
    ENTRY(read_file,shim,"fread",read_fn);
    char file_path[1024];join(file_path,sizeof file_path,argv[2],"positions");
    void *file=open_file(file_path,"w+");CHECK(file);int64_t at=((int64_t)3<<30)+19;
    CHECK(setpos(file,&at)==0);struct {uint64_t before;int64_t value;uint64_t after;} pos={0x1234,-1,0x5678};
    CHECK(getpos(file,&pos.value)==0&&pos.value==at&&pos.before==0x1234&&pos.after==0x5678);
    errno=0;CHECK(getpos(file,NULL)==-1&&errno==EINVAL);CHECK(setpos(file,NULL)==-1&&errno==EINVAL);
    at=0;CHECK(setpos(file,&at)==0);CHECK(close_file(file)==0);
    int pipes[2];CHECK(pipe(pipes)==0);FILE *pipe_file=fdopen(pipes[0],"r");CHECK(pipe_file);pos.value=93;
    CHECK(getpos(pipe_file,&pos.value)==-1&&pos.value==93);CHECK(fclose(pipe_file)==0);CHECK(close(pipes[1])==0);

    ENTRY(sign,shim,"__signbit",sign_fn);ENTRY(signf,shim,"__signbitf",signf_fn);
    CHECK(!sign(0.0)&&sign(-0.0)&&!sign(INFINITY)&&sign(-INFINITY));CHECK(!signf(0.0f)&&signf(-0.0f));
    CHECK(sign(copysign(NAN,-1.0))&&!sign(copysign(NAN,1.0)));
    ENTRY(round_d,shim,"lround",round_fn);ENTRY(round_f,shim,"lroundf",roundf_fn);
    ENTRY(round_ll,shim,"llround",llround_fn);ENTRY(round_llf,shim,"llroundf",llroundf_fn);
    CHECK(round_d(2.5)==3&&round_d(-2.5)==-3);CHECK(round_f(1.5f)==2&&round_f(-1.5f)==-2);
    CHECK(round_ll(2.5)==3&&round_ll(-2.5)==-3&&round_llf(1.5f)==2&&round_llf(-1.5f)==-2);

    char obb[1024],base[1024],zip[1024],directory[1024],real[1024],virtual_path[1024];
    join(obb,sizeof obb,argv[2],"obb");join(base,sizeof base,argv[2],"game");CHECK(mkdir(obb,0700)==0);CHECK(mkdir(base,0700)==0);
    join(zip,sizeof zip,obb,"fixture.obb");archive(zip);
    ((roots_fn)exported("kl_obbmap_init"))(obb,base);
    join(directory,sizeof directory,base,"Content/Paks");join(real,sizeof real,directory,"real.txt");join(virtual_path,sizeof virtual_path,directory,"virtual.pak");
    FILE *ordinary=fopen(real,"w");CHECK(ordinary);CHECK(fputs("real",ordinary)>=0);CHECK(fclose(ordinary)==0);
    ENTRY(open_dir,shim,"opendir",opendir_fn);ENTRY(read_dir,shim,"readdir",readdir_fn);
    ENTRY(close_dir,shim,"closedir",close_fn);ENTRY(descriptor,shim,"dirfd",dirfd_fn);
    for(int iteration=0;iteration<3;++iteration){
        void *dir=open_dir(directory);CHECK(dir);int fd=descriptor(dir);CHECK(fd>=0);struct stat a,b;
        CHECK(fstat(fd,&a)==0&&stat(directory,&b)==0&&a.st_ino==b.st_ino&&a.st_dev==b.st_dev);
        int real_count=0,virtual_count=0,count=0;guest_dirent *entry;
        while((entry=read_dir(dir))){CHECK(++count<16);real_count+=!strcmp(entry->name,"real.txt");virtual_count+=!strcmp(entry->name,"virtual.pak");}
        CHECK(real_count==1&&virtual_count==1);CHECK(descriptor(dir)==fd);CHECK(fcntl(fd,F_GETFD)>=0);CHECK(read_dir(dir)==NULL);
        CHECK(close_dir(dir)==0);errno=0;CHECK(fcntl(fd,F_GETFD)==-1&&errno==EBADF);
    }
    void *held[128];int held_fds[128];for(unsigned i=0;i<128;++i){held[i]=open_dir(directory);CHECK(held[i]);held_fds[i]=descriptor(held[i]);CHECK(held_fds[i]>=0);}
    for(unsigned i=0;i<128;++i){CHECK(close_dir(held[i])==0);errno=0;CHECK(fcntl(held_fds[i],F_GETFD)==-1&&errno==EBADF);}
    void *recovered=open_dir(directory);CHECK(recovered&&descriptor(recovered)>=0);CHECK(close_dir(recovered)==0);
    file=open_file(virtual_path,"rb");CHECK(file);char bytes[32]={0};CHECK(read_file(bytes,1,7,file)==7&&!memcmp(bytes,"virtual",7));
    CHECK(getpos(file,&at)==0&&at==7);CHECK(read_file(bytes,1,5,file)==5&&!memcmp(bytes,"-data",5));
    CHECK(setpos(file,&at)==0);CHECK(read_file(bytes,1,5,file)==5&&!memcmp(bytes,"-data",5));CHECK(close_file(file)==0);

    CHECK(unlink(real)==0&&rmdir(directory)==0);void *virtual_dir=open_dir(directory);CHECK(virtual_dir);errno=0;
    CHECK(descriptor(virtual_dir)==-1&&errno==EBADF);guest_dirent *only=read_dir(virtual_dir);CHECK(only&&!strcmp(only->name,"virtual.pak"));
    CHECK(read_dir(virtual_dir)==NULL&&close_dir(virtual_dir)==0);
    void *plain=open_dir(argv[2]);CHECK(plain);int plain_fd=descriptor(plain);CHECK(plain_fd>=0);CHECK(close_dir(plain)==0);
    CHECK(fcntl(plain_fd,F_GETFD)==-1);dlclose(library);
    printf("PASS actual Klepton positions/OBB descriptor ownership: %u checks\n",checks);return 0;
}

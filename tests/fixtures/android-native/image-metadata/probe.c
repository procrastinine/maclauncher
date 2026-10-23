#include "proc-maps.h"
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

typedef struct {
 unsigned char ident[16];unsigned short type,machine;unsigned version;
 unsigned long long entry,phoff,shoff;unsigned flags;
 unsigned short ehsize,phentsize,phnum,shentsize,shnum,shstrndx;
} Header;
_Static_assert(sizeof(Header)==64,"ELF64 header layout");
typedef struct {
 uint64_t base;const char *name;const void *headers;unsigned short count;
 unsigned long long adds,subs;size_t tls;void *tls_data;
} PhdrInfo;
static const KlProgramHeader *original;static unsigned original_count;
static uint64_t image_base;static const char *image_file;
static int (*elf_file)(uint64_t,const KlProgramHeader *,size_t,uint64_t,const char *,const char *,uint64_t,KljProcMapFile *);
static int bounded_lookup(uint64_t address,KljProcMapFile *file){
 return elf_file(image_base,original,original_count,(uint64_t)getpagesize(),image_file,"/data/app/metadata/libmetadata.so",address,file);
}
static int enumerated;
static int visit(void *opaque,size_t size,void *data){
 PhdrInfo *info=opaque;(void)data;assert(size>=offsetof(PhdrInfo,adds));
 assert(!strcmp(info->name,"libmetadata.so"));assert(info->base==image_base);
 assert(info->headers==original&&info->count==original_count);enumerated++;return 1;
}
int main(int argc,char **argv){
 assert(argc==3);void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){fprintf(stderr,"%s\n",dlerror());return 2;}
 void *(*load)(const char*)=dlsym(core,"kl_load");void(*unload)(void*)=dlsym(core,"kl_unload");
 void(*publish)(const char*,void*)=dlsym(core,"kl_register_image");
 void *(*base)(void*)=dlsym(core,"kl_base");size_t(*span)(void*)=dlsym(core,"kl_span");
 const KlProgramHeader *(*headers)(void*,unsigned*)=dlsym(core,"kl_phdrs");
 int(*iterate)(int(*)(void*,size_t,void*),void*)=dlsym(core,"kl_dl_iterate_phdr");
 int(*format)(FILE*,const KljProcMapRegion*,size_t,KljProcMapLookup)=dlsym(core,"klj_proc_maps_format");
 elf_file=dlsym(core,"klj_proc_maps_elf_file");assert(load&&unload&&publish&&base&&span&&headers&&iterate&&format&&elf_file);
 void *unpublished=load(argv[2]);assert(unpublished);unsigned temporary_count=0;assert(headers(unpublished,&temporary_count)&&temporary_count);unload(unpublished);
 void *image=load(argv[2]);assert(image);image_file=argv[2];image_base=(uintptr_t)base(image);size_t image_span=span(image);
 original=headers(image,&original_count);assert(original&&original_count);
 Header *header=(Header*)(uintptr_t)image_base;assert(!memcmp(header->ident,"\177ELF",4));
 assert((uintptr_t)original==image_base+header->phoff);assert(header->phentsize==sizeof(*original)&&header->phnum==original_count);
 assert(original_count<=image_span/sizeof(*original));
 assert((uintptr_t)original>=image_base&&(uintptr_t)original-image_base<=image_span-original_count*sizeof(*original));
 publish("libmetadata.so",image);assert(iterate(visit,NULL)==1&&enumerated==1);
 size_t page=(size_t)getpagesize();uintptr_t writable=image_base&~(uintptr_t)(page-1);
 size_t length=(((uintptr_t)(original+original_count)+page-1)&~(uintptr_t)(page-1))-writable;
 assert(!mprotect((void*)writable,length,PROT_READ|PROT_WRITE));
 header->ident[0]=0;header->phentsize=1;header->phnum=0;
 unsigned count=999;const KlProgramHeader *after=headers(image,&count);
 if(after!=original||count!=original_count){fputs("FAIL mapped PHDR identity changed after live ELF header mutation\n",stderr);fflush(stderr);_Exit(42);}
 assert((uintptr_t)base(image)==image_base&&span(image)==image_span);
 unsigned mutable=0;while(mutable<original_count&&original[mutable].type==1)mutable++;assert(mutable<original_count);
 KlProgramHeader *live=(KlProgramHeader*)original;uint64_t before=live[mutable].paddr;live[mutable].paddr=before^0x12345678u;
 assert(headers(image,&count)==original&&count==original_count);assert(headers(image,&count)[mutable].paddr==(before^0x12345678u));
 live[mutable].paddr=before;assert(!mprotect((void*)writable,length,PROT_READ));
 enumerated=0;assert(iterate(visit,NULL)==1&&enumerated==1);
 const KlProgramHeader *first=NULL;uint64_t mapped_end=0;
 for(unsigned i=0;i<original_count;i++)if(original[i].type==1&&original[i].filesz){
  if(!first)first=&original[i];uint64_t end=image_base+((original[i].vaddr+original[i].filesz+page-1)&~(uint64_t)(page-1));if(end>mapped_end)mapped_end=end;
 }assert(first&&mapped_end);
 uint64_t address=image_base+first->vaddr;KljProcMapFile file={0};assert(bounded_lookup(address,&file));assert(file.start<=address&&address<file.end);assert(!strcmp(file.path,"/data/app/metadata/libmetadata.so"));
 assert(file.end<=mapped_end);KljProcMapFile outside={0};assert(!bounded_lookup(mapped_end,&outside));
 KljProcMapRegion region={.start=file.start,.end=file.end,.offset=file.offset,.protection=PROT_READ,.path=image_file};
 char *text=NULL;size_t bytes=0;FILE *out=open_memstream(&text,&bytes);assert(out);assert(format(out,&region,1,bounded_lookup));fclose(out);
 assert(bytes&&strstr(text,"/data/app/metadata/libmetadata.so")&&!strstr(text,image_file));free(text);
 puts("PASS mapped PHDR pointer/count, live contents, iterate stop, bounded private formatter and unpublished unload");fflush(stdout);_Exit(0);
}

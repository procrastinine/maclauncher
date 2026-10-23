#include <elf.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef LIBRARY
__asm__(".text\n.global copied_original\n.type copied_original,%function\n"
        ".p2align 4\ncopied_original:\nmrs x0,tpidr_el0\nret\n"
        ".size copied_original,.-copied_original\n"
        ".global copied_new\n.type copied_new,%function\n"
        ".p2align 4\ncopied_new:\nmov x0,#7\nret\n"
        ".size copied_new,.-copied_new\n.space 16384\n"
        ".global copied_later\n.type copied_later,%function\n"
        "copied_later:\nmrs x0,tpidr_el0\nret\n"
        ".size copied_later,.-copied_later\n");
#else
static uint64_t symbol(const uint8_t *bytes,const char *name) {
    const Elf64_Ehdr *header=(const Elf64_Ehdr *)bytes;
    const Elf64_Shdr *sections=(const Elf64_Shdr *)(bytes+header->e_shoff);
    for(unsigned i=0;i<header->e_shnum;i++)if(sections[i].sh_type==SHT_DYNSYM){
        const Elf64_Sym *symbols=(const Elf64_Sym *)(bytes+sections[i].sh_offset);
        const char *strings=(const char *)bytes+sections[sections[i].sh_link].sh_offset;
        for(size_t k=0;k<sections[i].sh_size/sizeof *symbols;k++)
            if(!strcmp(strings+symbols[k].st_name,name))return symbols[k].st_value;
    }
    return 0;
}
int main(int argc,char **argv) {
    if(argc!=2)return 1;
    int fd=open(argv[1],O_RDONLY);struct stat st;
    if(fd<0||fstat(fd,&st))return 2;
    uint8_t *bytes=malloc((size_t)st.st_size);
    if(!bytes||pread(fd,bytes,(size_t)st.st_size,0)!=st.st_size)return 3;
    const Elf64_Ehdr *header=(const Elf64_Ehdr *)bytes;
    const Elf64_Phdr *loads=(const Elf64_Phdr *)(bytes+header->e_phoff);
    uint64_t old=symbol(bytes,"copied_original"),fresh=symbol(bytes,"copied_new");
    uint64_t later=symbol(bytes,"copied_later");
    const Elf64_Phdr *load=NULL;
    for(unsigned i=0;i<header->e_phnum;i++)if(loads[i].p_type==PT_LOAD&&
        (loads[i].p_flags&PF_X)&&old>=loads[i].p_vaddr&&
        old+8<=loads[i].p_vaddr+loads[i].p_filesz)load=&loads[i];
    if(!load||!old||!fresh||!later)return 4;
    size_t page=(size_t)sysconf(_SC_PAGESIZE);
    uint64_t offset=load->p_offset&~UINT64_C(4095),leading=load->p_offset-offset;
    size_t count=(size_t)(leading+load->p_filesz),size=(count+page-1)&~(page-1);
    void *mapping=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(mapping==MAP_FAILED||pread(fd,mapping,count,(off_t)offset)!=(ssize_t)count)return 5;
    uint32_t *original=(uint32_t *)((uint8_t *)mapping+leading+old-load->p_vaddr);
    uint32_t *created=(uint32_t *)((uint8_t *)mapping+leading+fresh-load->p_vaddr);
    uint32_t *untouched=(uint32_t *)((uint8_t *)mapping+leading+later-load->p_vaddr);
    if((uintptr_t)(created+2)>(uintptr_t)mapping+page||
       (uintptr_t)untouched<(uintptr_t)mapping+page)return 4;
    if(mprotect(mapping,page,PROT_READ|PROT_EXEC))return 6;
    if((*original&0xfc000000u)!=0x14000000u)return 7;
    if(*untouched!=0xd53bd040u)return 7;
    if(mprotect(mapping,page,PROT_READ|PROT_WRITE))return 8;
    original[0]=0xd28000e0u;created[0]=0xd53bd040u;
    __builtin___clear_cache(mapping,(char *)mapping+size);
    if(mprotect(mapping,size,PROT_READ|PROT_EXEC))return 9;
    printf("copied publication old=%08x new=%08x later=%08x\n",*original,*created,*untouched);
    if(*original!=0xd28000e0u||(*created&0xfc000000u)!=0x14000000u||
       (*untouched&0xfc000000u)!=0x14000000u)return 10;
    uintptr_t expected;__asm__("mrs %0,tpidr_el0":"=r"(expected));
    uintptr_t (*old_entry)(void)=(void *)original,(*new_entry)(void)=(void *)created;
    uintptr_t (*later_entry)(void)=(void *)untouched;
    if(old_entry()!=7||new_entry()!=expected||later_entry()!=expected)return 11;
    if(munmap(mapping,size)||close(fd))return 12;
    free(bytes);puts("PASS original Bionic copied ELF republishes current instructions");return 0;
}
#endif

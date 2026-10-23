#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef KL_X18_CORE_SOURCE
#include KL_X18_CORE_SOURCE
#else
#include "klepton.h"
#include "image-elf-types.h"
#include "image-code-ranges.h"
#include KL_X18_SOURCE
#endif

enum { FILE_SIZE=0x1003, STATE_SIZE=(FILE_SIZE+3)/4, LOAD_ADDRESS=0x4000 };

/* A synthetic initializer is in the executable segment beyond the shortened
 * code section. Constants and typed metadata deliberately resemble x18 code.
 * No fixture instruction or guest library is executed. */
static void make_image(uint8_t *file,int sections) {
    memset(file,0,FILE_SIZE);
    Elf64_Ehdr *eh=(void *)file;
    memcpy(eh->e_ident,"\177ELF\2\1\1",7);
    eh->e_type=3;eh->e_machine=183;eh->e_version=1;
    eh->e_ehsize=sizeof *eh;eh->e_phoff=sizeof *eh;
    eh->e_phnum=3;eh->e_phentsize=sizeof(Elf64_Phdr);
    eh->e_flags=0xaa0003f2u;
    if(sections){eh->e_shoff=0x100;eh->e_shnum=3;eh->e_shentsize=sizeof(Elf64_Shdr);}
    Elf64_Phdr *ph=(void *)(file+eh->e_phoff);
    ph[0]=(Elf64_Phdr){.p_type=PT_LOAD,.p_flags=PF_R|PF_X,.p_vaddr=LOAD_ADDRESS,.p_filesz=FILE_SIZE,.p_memsz=FILE_SIZE,.p_align=0x1000};
    ph[1]=(Elf64_Phdr){.p_type=PT_DYNAMIC,.p_flags=PF_R,.p_offset=0x200,.p_vaddr=LOAD_ADDRESS+0x200,.p_filesz=32,.p_memsz=32,.p_align=8};
    ph[2]=(Elf64_Phdr){.p_type=4,.p_flags=PF_R,.p_offset=0xa00,.p_vaddr=LOAD_ADDRESS+0xa00,.p_filesz=32,.p_memsz=32,.p_align=4};
    if(sections){
        Elf64_Shdr *sh=(void *)(file+eh->e_shoff);
        sh[1]=(Elf64_Shdr){.sh_type=SHT_PROGBITS,.sh_flags=2|SHF_EXECINSTR,.sh_addr=LOAD_ADDRESS+0x400,.sh_offset=0x400,.sh_size=0x40};
        sh[2]=(Elf64_Shdr){.sh_type=7,.sh_flags=2,.sh_addr=LOAD_ADDRESS+0xa00,.sh_offset=0xa00,.sh_size=32};
    }
    const uint64_t dynamic[]={12,LOAD_ADDRESS+0x800,0,0}; /* DT_INIT, DT_NULL */
    memcpy(file+0x200,dynamic,sizeof dynamic);
    const uint32_t note[]={4,16,1,0x00554e47,0xaa0003f2,0xd53bd052,0x00010203,0xdeadbeef};
    memcpy(file+0xa00,note,sizeof note);
    uint32_t *constants=(void *)(file+0x400);
    for(size_t i=0;i<64;i++)constants[i]=0x00010203u+(uint32_t)(i*0x101u);
    constants[8]=0xaa0003f2u;
    const uint32_t initializer[]={0xa9bf7bfd,0x910003fd,0xaa0003f2,0x940000bdu,0xa8c17bfd,0xd65f03c0};
    memcpy(file+0x800,initializer,sizeof initializer);
    const uint32_t conditional[]={0xa9be7bfd,0xa9014ff4,0x910003fd,0xd10043ff,
        0xd53bd053,0x52805009,0xf9401668,0x54000061,
        0x267fd060,0x83bd5adc,0xd65f03c0};
    memcpy(file+0xb00,conditional,sizeof conditional);
    file[FILE_SIZE-3]=0x12;file[FILE_SIZE-2]=0x34;file[FILE_SIZE-1]=0x56;
}

#ifndef KL_X18_CORE_SOURCE
static void jvm_evidence(const uint8_t *file,uint8_t *state) {
    const Elf64_Ehdr *eh=(const void *)file;
    const Elf64_Phdr *ph=(const void *)(file+eh->e_phoff);
    const Elf64_Shdr *sh=eh->e_shnum?(const void *)(file+eh->e_shoff):NULL;
    KlImageCodeMetadata metadata={0};
    assert(klj_code_metadata_read(&metadata,file,FILE_SIZE,eh,ph,sh));
    memset(state,0,STATE_SIZE);
    KlImageCodeCursor cursor={.metadata=&metadata};KlImageCodeRange range;
    while(klj_image_code_next(eh,ph,sh,FILE_SIZE,&cursor,&range)) {
        klx_code_context context={metadata.marks,metadata.count,range.address,metadata.reachable,metadata.reachableCount};
        for(size_t k=0;k<range.size/4;k++) {
            uint64_t address=range.address+k*4;
            uint8_t value=kl_x18_is_data_context(file+range.offset,range.size,k,&context)?2:1;
            for(size_t r=0;r<metadata.reachableCount;r++)
                if(metadata.reachable[r].start<=address&&address<metadata.reachable[r].end)value|=4;
            state[(range.offset+k*4)/4]=value;
        }
    }
    klj_code_metadata_release(&metadata);
}
#endif

int main(int argc,char **argv) {
    assert(argc==2);FILE *output=fopen(argv[1],"wb");assert(output);
    /* A branch to undecodable bytes cannot prove an apparent function.
     * Conversely, proof must propagate through several unconditional hops
     * to a real return, without treating opaque fallthrough as code. */
    const uint64_t branch_root=0x1000;
    const uint32_t invalid_branch[]={0xaa0003f2,0x14000003,0,0,0x00010203};
    uint8_t invalid_state[5]={0};
    assert(!klx_instruction_evidence(invalid_branch,5,branch_root,&branch_root,1,invalid_state));
    for(size_t k=0;k<5;k++)assert(!(invalid_state[k]&1));
    const uint32_t valid_branch[]={0xaa0003f2,0x14000003,0x00010203,0,
        0xaa0103f2,0x14000003,0x00010203,0,0xd65f03c0};
    uint8_t valid_state[9]={0};
    assert(!klx_instruction_evidence(valid_branch,9,branch_root,&branch_root,1,valid_state));
    for(size_t k=0;k<9;k++)assert((valid_state[k]&1)==(k==0||k==1||k==4||k==5||k==8));
    const uint32_t cyclic_branch[]={0xaa0003f2,0x17ffffff};
    uint8_t cyclic_state[2]={0};
    assert(!klx_instruction_evidence(cyclic_branch,2,branch_root,&branch_root,1,cyclic_state));
    assert(!(cyclic_state[0]&1)&&!(cyclic_state[1]&1));
    for(int sections=0;sections<=1;sections++) {
        uint8_t *file=malloc(FILE_SIZE),*rewritten=malloc(FILE_SIZE);
        uint8_t state[STATE_SIZE+1];assert(file&&rewritten);
        make_image(file,sections);memset(state,0xa5,sizeof state);
#ifdef KL_X18_CORE_SOURCE
        assert(klx_elf_instruction_evidence(file,FILE_SIZE,state,STATE_SIZE-1)==-1);
        assert(klx_elf_instruction_evidence(file,FILE_SIZE,state,STATE_SIZE+1)==-1);
        assert(!klx_elf_instruction_evidence(file,FILE_SIZE,state,STATE_SIZE));
#else
        jvm_evidence(file,state);
#endif
        assert(state[STATE_SIZE]==0xa5&&state[STATE_SIZE-1]==0);
        assert((state[0x808/4]&5)==5); /* Reachable x18 outside .text. */
        assert((state[0xb10/4]&5)==5); /* Conditional path retains its TLS-read prefix. */
        assert(!(state[0xb20/4]&1)&&!(state[0xb24/4]&1)); /* Opaque fallthrough stays data. */
        assert(state[0x420/4]==2); /* Instruction-shaped constant. */
        assert(!state[0x200/4]&&!state[0xa10/4]); /* Dynamic table and note. */
        for(size_t i=0;i<sizeof(Elf64_Ehdr)/4;i++)assert(!state[i]);
        klx_info decoded;klx_decode(*(uint32_t *)(file+0x420),&decoded);assert(decoded.nfields);
        memcpy(rewritten,file,FILE_SIZE);unsigned sites=0;
        for(size_t i=0;i<FILE_SIZE/4;i++)if(state[i]&1) {
            uint32_t word;memcpy(&word,file+i*4,4);klx_decode(word,&decoded);
            if(decoded.nfields){word=0x14000000u;memcpy(rewritten+i*4,&word,4);sites++;}
        }
        assert(sites==1&&*(uint32_t *)(rewritten+0x808)==0x14000000u);
        memcpy(rewritten+0x808,file+0x808,4);
        assert(!memcmp(rewritten,file,FILE_SIZE)); /* Every other byte survives. */
        assert(fwrite(state,1,STATE_SIZE,output)==STATE_SIZE);
        free(rewritten);free(file);
    }
    assert(!fclose(output));
    puts("PASS whole-ELF shortened/stripped initializer discovery and preserved data/metadata bytes");
}

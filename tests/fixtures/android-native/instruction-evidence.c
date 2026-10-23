#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "klepton.h"
#include "image-elf-types.h"
#include "image-code-ranges.h"
#include KL_X18_SOURCE
int main(int argc,char **argv) {
    assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);fseek(f,0,SEEK_END);
    size_t size=(size_t)ftell(f);rewind(f);uint8_t *file=malloc(size);assert(file);
    assert(fread(file,1,size,f)==size);fclose(f);
    const Elf64_Ehdr *eh=(void*)file;const Elf64_Phdr *ph=(void*)(file+eh->e_phoff);
    const Elf64_Shdr *sh=eh->e_shoff?(void*)(file+eh->e_shoff):NULL;
    KlImageCodeMetadata metadata={0};assert(klj_code_metadata_read(&metadata,file,size,eh,ph,sh));
    const uint32_t table[]={0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xa81a664b,0xc24b8b70,0xc76c51a3,0x428a2f98};
    /* Unwind roots alone do not prove current bytes are instructions: packed
     * images can retain their pre-decryption function metadata. */
    const uint64_t apparent_roots[]={0x1010,0x1020,0x1030};uint8_t evidence[16]={0};
    assert(!klx_instruction_evidence(table,16,0x1000,apparent_roots,3,evidence));
    assert(!(evidence[4]&1)&&!(evidence[8]&1)&&!(evidence[12]&1));
    /* A decoded path reaches RET across opaque inline words. The ordinary
     * FP/LR and callee-save prefix includes a real TLS read before the branch;
     * failure to decode fallthrough must not erase that prefix. */
    const uint32_t split[]={0xa9be7bfd,0xa9014ff4,0x910003fd,0xd10043ff,
        0xd53bd053,0x52805009,0xf9401668,0x54000061,
        0x267fd060,0x83bd5adc,0xd65f03c0,0xd53bd052};
    const uint64_t split_root=0x2000;uint8_t split_state[12]={0};split_state[11]=2;
    assert(!klx_instruction_evidence(split,12,split_root,&split_root,1,split_state));
    for(size_t k=0;k<8;k++)assert(split_state[k]&1);
    assert(!(split_state[8]&1)&&!(split_state[9]&1));
    assert(split_state[10]&1);assert(split_state[11]==2);
    uint8_t *original=malloc(size);assert(original);memcpy(original,file,size);
    KlImageCodeCursor cursor={.metadata=&metadata};KlImageCodeRange range;unsigned sites=0;
    while(klj_image_code_next(eh,ph,sh,size,&cursor,&range)) {
        klx_code_context context={metadata.marks,metadata.count,range.address,metadata.reachable,metadata.reachableCount};
        uint32_t *words=(void*)(file+range.offset);
        for(size_t k=0;k<range.size/4;k++) {
            klx_info info;klx_decode(words[k],&info);
            if(info.nfields&&!kl_x18_is_data_context(words,range.size,k,&context)){words[k]=0x14000000;sites++;}
        }
    }
    int found=0;for(size_t k=0;k+sizeof table<=size;k+=4)if(!memcmp(original+k,table,sizeof table)){
        assert(!memcmp(file+k,table,sizeof table));found++;
        /* The code immediately beside the table is reachable through BLR. */
        assert(*(uint32_t*)(file+k+sizeof table)==0x14000000);
        assert(*(uint32_t*)(file+k+sizeof table+4)==0x14000000);
    }
    assert(found==1&&sites==2);klj_code_metadata_release(&metadata);free(original);free(file);
    puts("PASS shared ELF literal bytes, indirect code and reachable x18");
}

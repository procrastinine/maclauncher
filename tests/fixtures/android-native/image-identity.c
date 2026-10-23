#include <assert.h>
#include <stdio.h>
#include "image-identity.h"

int main(int argc,char **argv) {
    assert(argc==4);
    for(int n=1;n<argc;n++) {
        char *name=klj_elf_soname(argv[n]);
        assert(name && !strcmp(name,"libdeclared.so"));
        free(name);
    }
    unsigned char malformed[64]={0x7f,'E','L','F',2,1};
    assert(!klj_elf_soname_bytes(malformed,sizeof malformed));
    malformed[4]=1;
    assert(!klj_elf_soname_bytes(malformed,sizeof malformed));
    puts("PASS ELF32/ELF64 immutable SONAME identity and malformed bounds");
}

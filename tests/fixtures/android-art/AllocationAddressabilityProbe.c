#include <assert.h>
#include <malloc.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void){
    unsigned char *source=malloc(8);assert(source);
    const size_t usable=malloc_usable_size(source),alignment=_Alignof(max_align_t);
    assert(usable>=8&&alignment>=16&&(uintptr_t)source%alignment==0);
    memset(source,0x5a,8);
    unsigned char copied[12];memcpy(copied,source,sizeof copied);
    for(size_t i=0;i<8;++i)assert(copied[i]==0x5a);
    printf("PASS original Bionic allocated=8 usable=%zu alignment=%zu native-read=%zu\n",usable,alignment,sizeof copied);
    free(source);return 0;
}

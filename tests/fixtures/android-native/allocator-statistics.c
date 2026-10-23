#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <malloc/malloc.h>
#include "allocator-abi.h"
extern void *klj_allocator_lookup(const char *);
FILE *kl_host_file(void *stream){return stream;}
int main(void){
    _Static_assert(sizeof(struct klj_mallinfo)==10*sizeof(size_t),"Original Bionic mallinfo ABI");
    struct klj_mallinfo (*info)(void)=klj_allocator_lookup("mallinfo");
    int (*xml)(int,void *)=klj_allocator_lookup("malloc_info");
    assert(info&&xml&&klj_allocator_lookup("mallinfo2")==info);
    struct klj_mallinfo before=info();
    size_t extent=32u<<20;void *allocation=malloc(extent);assert(allocation);memset(allocation,0x37,extent);
    struct klj_mallinfo during=info();
    assert(during.uordblks>=before.uordblks+extent);
    assert(during.hblkhd>=during.uordblks);
    assert(during.fordblks==during.hblkhd-during.uordblks);
    free(allocation);struct klj_mallinfo after=info();
    assert(after.uordblks<=during.uordblks-extent);
    FILE *stream=tmpfile();assert(stream);assert(xml(0,stream)==0);rewind(stream);
    char buffer[1024];size_t length=fread(buffer,1,sizeof(buffer)-1,stream);buffer[length]=0;
    assert(strstr(buffer,"<malloc version=\"darwin-1\">")&&strstr(buffer,"<allocated>")&&strstr(buffer,"</malloc>"));
    errno=0;assert(xml(1,stream)==-1&&errno==EINVAL);assert(fclose(stream)==0);
    assert(klj_allocator_lookup("unknown_allocator_api")==NULL);
    puts("PASS original Android allocator record reflects real allocation and release");
}

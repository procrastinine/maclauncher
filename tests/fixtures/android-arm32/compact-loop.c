#include <stdint.h>

uint32_t compact_loop(volatile uint32_t *a,volatile uint32_t *b,
                      volatile uint32_t *c,volatile uint32_t *d,uint32_t rounds){
    uint32_t checksum=0;
    for(uint32_t round=0;round<rounds;++round)
        for(uint32_t i=0;i<32;++i){
            d[i]=(a[i]+b[i])+(c[i]^(round+i));
            checksum+=d[i];
        }
    return checksum;
}

extern void checkpoint(void);
uint32_t compact_transition(volatile uint32_t *a,volatile uint32_t *b,
                            volatile uint32_t *c,volatile uint32_t *d){
    uint32_t first=a[0]+b[0]+c[0]+d[0];
    checkpoint();
    return first+a[0]+b[0]+c[0]+d[0];
}
uint32_t compact_bounds(volatile uint32_t *a){return a[16];}

uint32_t compact_many(volatile uint32_t *volatile *buffers,uint32_t count,uint32_t rounds){
    uint32_t checksum=0;
    for(uint32_t round=0;round<rounds;++round)
        for(uint32_t index=0;index<count;++index){
            volatile uint32_t *buffer=buffers[index];
            const uint32_t offset=round&31;
            buffer[offset]+=index+round+1;
            checksum+=buffer[offset];
        }
    return checksum;
}

uint64_t compact_widths(volatile uint8_t *bytes,uint32_t width,uint64_t value,uint32_t writing){
    if(width==8){
        if(writing){*(volatile uint64_t *)bytes=value;return value;}
        return *(volatile uint64_t *)bytes;
    }
    if(width==4){
        if(writing){*(volatile uint32_t *)bytes=(uint32_t)value;return value;}
        return *(volatile uint32_t *)bytes;
    }
    if(width==2){
        if(writing){*(volatile uint16_t *)bytes=(uint16_t)value;return value;}
        return *(volatile uint16_t *)bytes;
    }
    if(writing){*bytes=(uint8_t)value;return value;}
    return *bytes;
}

// Volatile reads retain one straight-line guest block with enough generated
// memory operations to put its deferred callbacks beyond a TBZ's 32 KiB range.
uint32_t compact_large(volatile uint32_t *bytes){
    uint32_t sum=0;
#define READ1 sum+=*bytes;
#define READ4 READ1 READ1 READ1 READ1
#define READ16 READ4 READ4 READ4 READ4
#define READ64 READ16 READ16 READ16 READ16
#define READ256 READ64 READ64 READ64 READ64
    READ256 READ256
#undef READ256
#undef READ64
#undef READ16
#undef READ4
#undef READ1
    return sum;
}

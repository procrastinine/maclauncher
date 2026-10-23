#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#ifdef KL_X18_CORE_SOURCE
#include KL_X18_CORE_SOURCE
#else
#include KL_X18_SOURCE
#endif

int main(void) {
    /* Unallocated scalar conversions, SIMD memory forms and register-index
     * extensions. These bytes must survive even in an executable mapping. */
    const uint32_t reserved[]={0x1e4f1e4d,0x3e573e41,0x7defb64d,
        0x783cbab2,0x7da92643,0x3cf2e0a6,0x783f8b92,0x7cb232af,
        0x7d822e55,0x7dee965a,0x7ded2a47};
    for(size_t i=0;i<sizeof reserved/sizeof *reserved;i++) {
        klx_info info;klx_decode(reserved[i],&info);
        assert(!info.ok&&!info.nfields&&klx_unallocated(reserved[i]));
    }
    /* Independently assembled valid B/H/S/D/Q memory widths, all four
     * register-index extensions, FP16 conversions, fixed-point bounds,
     * rounding conversions, FMOV low/high lanes and FJCVTZS. */
    const uint32_t allocated[]={0x38000012,0x78000012,0xb8000012,0xf8000012,
        0x3d400240,0x7d400240,0xbd400240,0xfd400240,0x3dc00240,0x3d800240,
        0x7c217a40,0xf8615812,0xf8617812,0xf861d812,0xf861f812,
        0x1e02fe40,0x9e430240,0x1e18fc12,0x9e590012,0x1ee20240,
        0x9e630240,0x1e240012,0x9e680012,0x1e260012,0x9e660012,
        0x9eaf0240,0x9eae0012,0x1ee60012,0x9ee60012,0x1e7e0012};
    for(size_t i=0;i<sizeof allocated/sizeof *allocated;i++) {
        klx_info info;klx_decode(allocated[i],&info);
        if(!info.ok||!info.nfields||klx_unallocated(allocated[i]))
            fprintf(stderr,"allocated word=%08x ok=%d fields=%u\n",allocated[i],info.ok,info.nfields);
        assert(info.ok&&info.nfields&&!klx_unallocated(allocated[i]));
    }
    /* GP-looking SIMD register numbers are never GP operands. */
    const uint32_t vector_only[]={0x3d400012,0x7d400012,0xbd400012,0xfd400012,0x3dc00012};
    for(size_t i=0;i<sizeof vector_only/sizeof *vector_only;i++) {
        klx_info info;klx_decode(vector_only[i],&info);assert(info.ok&&!info.nfields);
    }
    puts("PASS 11 reserved memory/FP words preserved, 30 allocated x18 forms and five SIMD operand banks retained");
}

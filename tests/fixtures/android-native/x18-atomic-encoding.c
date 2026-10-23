#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include KL_X18_SOURCE

static void packed_word(int fixed) {
    uint32_t code[33], pool[256];
    for (unsigned i = 0; i < 33; i++) code[i] = 0xd503201fu;
    code[16] = 0x08b9c9fau;
    kl_x18_stats stats; size_t used;
    assert(!kl_x18_emit(code, sizeof code, 0x100000, pool, sizeof pool, 0x200000, &stats, &used));
    if (fixed) assert(!stats.patched && code[16] == 0x08b9c9fau);
    else assert(stats.patched == 1 && code[16] != 0x08b9c9fau);
}

static void atomic(unsigned form, unsigned order) {
    size_t size = 32768;
    uint8_t *memory = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    assert(memory != MAP_FAILED);
    uint32_t *code = (void *)memory, *pool = (void *)(memory + 16384); unsigned k = 0;
    code[k++] = enc_movz(16, 0x1616, 0); code[k++] = enc_movz(17, 0x1717, 0);
    code[k++] = 0xaa0103f2u; // mov x18,x1: original address in the virtual register
    code[k++] = 0xeb01003fu; // cmp x1,x1
    code[k++] = 0xd53b4208u; // mrs x8,nzcv
    unsigned acquire = (order & 1) << 22, release = (order >> 1) << 15;
    if (form == 0) {
        code[k++] = enc_movz(1, 11, 0); code[k++] = enc_movz(2, 21, 0);
        code[k++] = 0xc8a17e42u | acquire | release; // CAS{A}{L} x1,x2,[x18]
        code[k++] = enc_str(1, 0, 0);
    } else if (form == 1) {
        code[k++] = enc_movz(4, 11, 0); code[k++] = enc_movz(5, 12, 0);
        code[k++] = enc_movz(6, 21, 0); code[k++] = enc_movz(7, 22, 0);
        code[k++] = 0x48247e46u | acquire | release; // CASP{A}{L} x4,x5,x6,x7,[x18]
        code[k++] = enc_str(4, 0, 0); code[k++] = enc_str(5, 0, 8);
    } else {
        code[k++] = enc_movz(2, 21, 0);
        code[k++] = 0xc89ffe42u; // stlr x2,[x18]
        code[k++] = 0xc8dffe43u; // ldar x3,[x18]
        code[k++] = enc_str(3, 0, 0);
    }
    code[k++] = 0xd53b4209u; // mrs x9,nzcv
    code[k++] = enc_str(8, 0, 16); code[k++] = enc_str(9, 0, 24);
    code[k++] = enc_str(16, 0, 32); code[k++] = enc_str(17, 0, 40);
    code[k++] = 0xd65f03c0u;
    kl_x18_stats stats; size_t used;
    assert(!kl_x18_emit(code, k * 4, (uintptr_t)code, pool, 16384, (uintptr_t)pool, &stats, &used));
    assert(!stats.refused && stats.patched >= 2);
    assert(!mprotect(memory, size, PROT_READ | PROT_EXEC)); sys_icache_invalidate(memory, size);
    uint64_t data[2] __attribute__((aligned(16))) = {11, 12}, output[6] = {0};
    ((void (*)(uint64_t *, uint64_t *))code)(output, data);
    assert(output[0] == (form == 2 ? 21 : 11));
    assert(data[0] == 21 && data[1] == (form == 1 ? 22 : 12));
    if (form == 1) assert(output[1] == 12);
    assert(output[2] == output[3] && output[4] == 0x1616 && output[5] == 0x1717);
    assert(!munmap(memory, size));
}

int main(int argc, char **argv) {
    assert(argc == 2); int fixed = atoi(argv[1]); packed_word(fixed);
    if (!fixed) { puts("PASS previous decoder reproduced mutation of reserved packed word"); return 0; }
    for (unsigned form = 0; form < 2; form++) for (unsigned order = 0; order < 4; order++) atomic(form, order);
    atomic(2, 0);
    puts("PASS reserved atomic bytes preserved and 9 native CAS/CASP/ordered x18 address veneers execute with scratch and NZCV intact");
}

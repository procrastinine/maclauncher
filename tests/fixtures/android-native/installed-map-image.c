#include <elf.h>
#include <stdint.h>
/* A normal NDK ELF with separate file-backed and zero-fill regions. */
const uint32_t map_image_rodata[4]={PT_LOAD,PF_R,PF_W,PF_X};
uint32_t map_image_data=73;
uint8_t map_image_bss[65536];
int map_image_value(void){return (int)(map_image_data+map_image_rodata[0]+map_image_bss[0]);}

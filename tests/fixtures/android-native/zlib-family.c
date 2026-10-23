#include <jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <string.h>
#include <zlib.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#define FN(name) __typeof__(&name) call_##name=name;assert(call_##name)
static int allocations,frees;
static void *allocate(void *opaque,uInt count,uInt size){assert(opaque==&allocations);allocations++;return calloc(count,size);}
static void release(void *opaque,void *p){assert(opaque==&allocations);frees++;free(p);}
JNIEXPORT void JNICALL Java_ZlibGuestProbe_compression(JNIEnv *env,jclass type) {
    (void)env;(void)type;
    Dl_info owner={0};assert(dladdr((void *)zlibVersion,&owner)&&owner.dli_fname&&strstr(owner.dli_fname,"libz.so"));
    FN(compress);FN(compress2);FN(compressBound);FN(uncompress);FN(uncompress2);FN(zlibVersion);
    const unsigned char original[]="actual Android zlib memory stream and checksum compatibility";
    unsigned char compressed[256],restored[256];uLong compressedSize=sizeof compressed,restoredSize=sizeof restored;
    assert(call_compressBound(sizeof original)<=sizeof compressed);
    assert(call_compress(compressed,&compressedSize,original,sizeof original)==Z_OK);
    assert(call_uncompress(restored,&restoredSize,compressed,compressedSize)==Z_OK);
    assert(restoredSize==sizeof original&&!memcmp(restored,original,sizeof original));
    restoredSize=2;assert(call_uncompress(restored,&restoredSize,compressed,compressedSize)==Z_BUF_ERROR);
    compressedSize=sizeof compressed;assert(call_compress2(compressed,&compressedSize,original,sizeof original,Z_BEST_COMPRESSION)==Z_OK);
    uLong consumed=compressedSize;restoredSize=sizeof restored;assert(call_uncompress2(restored,&restoredSize,compressed,&consumed)==Z_OK&&consumed==compressedSize);
    compressed[0]^=0xff;restoredSize=sizeof restored;assert(call_uncompress(restored,&restoredSize,compressed,compressedSize)==Z_DATA_ERROR);
    FN(deflateInit_);FN(deflateSetDictionary);FN(deflate);FN(deflateEnd);
    FN(inflateInit_);FN(inflateSetDictionary);FN(inflate);FN(inflateEnd);
    z_stream encoding={0},decoding={0};encoding.zalloc=allocate;encoding.zfree=release;encoding.opaque=&allocations;
    assert(call_deflateInit_(&encoding,Z_DEFAULT_COMPRESSION,call_zlibVersion(),sizeof encoding)==Z_OK);
    const unsigned char dictionary[]="Android zlib memory";
    assert(call_deflateSetDictionary(&encoding,dictionary,sizeof dictionary)==Z_OK);
    encoding.next_in=(Bytef *)original;encoding.avail_in=sizeof original;encoding.next_out=compressed;encoding.avail_out=sizeof compressed;
    assert(call_deflate(&encoding,Z_FINISH)==Z_STREAM_END);compressedSize=encoding.total_out;
    assert(call_deflateEnd(&encoding)==Z_OK&&allocations==frees);
    assert(call_inflateInit_(&decoding,call_zlibVersion(),sizeof decoding)==Z_OK);
    decoding.next_in=compressed;decoding.avail_in=(uInt)compressedSize;decoding.next_out=restored;decoding.avail_out=sizeof restored;
    assert(call_inflate(&decoding,Z_NO_FLUSH)==Z_NEED_DICT);
    assert(call_inflateSetDictionary(&decoding,dictionary,sizeof dictionary)==Z_OK);
    assert(call_inflate(&decoding,Z_FINISH)==Z_STREAM_END);
    assert(decoding.total_out==sizeof original&&!memcmp(restored,original,sizeof original));assert(call_inflateEnd(&decoding)==Z_OK);
    FN(crc32);FN(crc32_combine);FN(adler32);FN(adler32_combine);
    unsigned split=13;uLong c1=call_crc32(0,original,split),c2=call_crc32(0,original+split,sizeof original-split);
    assert(call_crc32_combine(c1,c2,sizeof original-split)==call_crc32(0,original,sizeof original));
    uLong a1=call_adler32(1,original,split),a2=call_adler32(1,original+split,sizeof original-split);
    assert(call_adler32_combine(a1,a2,sizeof original-split)==call_adler32(1,original,sizeof original));
    const uint32_t *(*crcTable)(void)=get_crc_table;assert(crcTable);
    const uint32_t *table=crcTable();assert(table[0]==0&&table[1]==UINT32_C(0x77073096));
    uint32_t crc=UINT32_MAX;for(size_t n=0;n<sizeof original;n++)crc=table[(crc^original[n])&255]^(crc>>8);
    assert((crc^UINT32_MAX)==call_crc32(0,original,sizeof original));
    puts("PASS original guest zlib buffer/stream/dictionary/checksum and callback lifetime");
}

/* Real guest client: JNI and NDK bitmap calls remain in the same Android ABI.
 * No host Skia headers, native object casts or synthetic symbol resolver. */
#include <jni.h>
#include <android/bitmap.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

JNIEXPORT jintArray JNICALL Java_maclauncher_android_NdkBitmapProbe_pixels(JNIEnv* env,jclass type,jobject bitmap){
    (void)type;
    AndroidBitmapInfo metadata={0};
    if(AndroidBitmap_getInfo(env,bitmap,&metadata)!=ANDROID_BITMAP_RESULT_SUCCESS)return NULL;
    void *address=NULL,*second=NULL;
    int result=AndroidBitmap_lockPixels(env,bitmap,&address);
    int nested=AndroidBitmap_lockPixels(env,bitmap,&second);
    uint8_t* bytes=address;
    jint values[]={(jint)metadata.width,(jint)metadata.height,(jint)metadata.stride,metadata.format,
        bytes?bytes[0]:-1,bytes?bytes[1]:-1,bytes?bytes[2]:-1,bytes?bytes[3]:-1,result,nested};
    if(bytes){bytes[4]=0;bytes[5]=255;bytes[6]=0;bytes[7]=255;}
    if(second!=address)values[9]=-9;
    if(nested==ANDROID_BITMAP_RESULT_SUCCESS)AndroidBitmap_unlockPixels(env,bitmap);
    if(result==ANDROID_BITMAP_RESULT_SUCCESS)AndroidBitmap_unlockPixels(env,bitmap);
    jintArray out=(*env)->NewIntArray(env,10);
    if(out)(*env)->SetIntArrayRegion(env,out,0,10,values);
    return out;
}
struct Output {uint8_t* bytes;size_t size;};
static bool writeBytes(void* context,const void* bytes,size_t size){
    struct Output* out=context;
    if(size>SIZE_MAX-out->size)return false;
    uint8_t* next=realloc(out->bytes,out->size+size);
    if(!next&&size)return false;
    if(size)memcpy(next+out->size,bytes,size);
    out->bytes=next;out->size+=size;return true;
}
JNIEXPORT jbyteArray JNICALL Java_maclauncher_android_NdkBitmapProbe_compress(JNIEnv* env,jclass type,jobject bitmap,jint format){
    (void)type;
    AndroidBitmapInfo metadata={0};void* pixels=NULL;
    if(AndroidBitmap_getInfo(env,bitmap,&metadata)!=ANDROID_BITMAP_RESULT_SUCCESS||
       AndroidBitmap_lockPixels(env,bitmap,&pixels)!=ANDROID_BITMAP_RESULT_SUCCESS)return NULL;
    struct Output bytes={0};
    int result=AndroidBitmap_compress(&metadata,AndroidBitmap_getDataSpace(env,bitmap),pixels,format,90,&bytes,writeBytes);
    AndroidBitmap_unlockPixels(env,bitmap);
    jbyteArray out=NULL;
    if(!result&&bytes.size<=INT_MAX){
        out=(*env)->NewByteArray(env,(jsize)bytes.size);
        if(out)(*env)->SetByteArrayRegion(env,out,0,(jsize)bytes.size,(const jbyte*)bytes.bytes);
    }
    free(bytes.bytes);return out;
}
JNIEXPORT jint JNICALL Java_maclauncher_android_NdkBitmapProbe_invalid(JNIEnv* env,jclass type,jobject bitmap,jboolean recycled){
    (void)type;
    AndroidBitmapInfo metadata={0};AHardwareBuffer* buffer=NULL;
    return AndroidBitmap_getInfo(NULL,bitmap,&metadata)==ANDROID_BITMAP_RESULT_BAD_PARAMETER&&
        AndroidBitmap_getInfo(env,NULL,&metadata)==ANDROID_BITMAP_RESULT_BAD_PARAMETER&&
        AndroidBitmap_getInfo(env,bitmap,&metadata)==ANDROID_BITMAP_RESULT_SUCCESS&&metadata.width==3&&
        AndroidBitmap_getHardwareBuffer(env,bitmap,&buffer)==(recycled?ANDROID_BITMAP_RESULT_JNI_EXCEPTION:ANDROID_BITMAP_RESULT_BAD_PARAMETER)?0:1;
}

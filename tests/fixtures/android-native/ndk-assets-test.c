#include <jni.h>
#include <android/configuration.h>
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>

static void fail(JNIEnv *env,const char *text){jclass type=(*env)->FindClass(env,"java/lang/AssertionError");if(type)(*env)->ThrowNew(env,type,text);}
#define CHECK(condition) do{if(!(condition)){fail(env,#condition);return;}}while(0)
static int check_asset(AAssetManager *manager,const char *name,int descriptor){
    AAsset *asset=AAssetManager_open(manager,name,AASSET_MODE_RANDOM);if(!asset)return 0;
    char bytes[11]={0};int ok=AAsset_getLength64(asset)==10&&AAsset_read(asset,bytes,3)==3&&!memcmp(bytes,"012",3);
    ok&=AAsset_seek64(asset,-2,SEEK_END)==8&&AAsset_getRemainingLength64(asset)==2;
    ok&=AAsset_read(asset,bytes,3)==2&&!memcmp(bytes,"89",2);
    ok&=AAsset_seek64(asset,11,SEEK_SET)==-1;
    const void *buffer=AAsset_getBuffer(asset);ok&=buffer&&!memcmp(buffer,"0123456789",10);
    off64_t offset=0,length=0;int fd=AAsset_openFileDescriptor64(asset,&offset,&length);
    if(descriptor){memset(bytes,0,sizeof bytes);ok&=fd>=0&&length==10&&pread(fd,bytes,10,offset)==10&&!memcmp(bytes,"0123456789",10);}
    else ok&=fd<0;
    AAsset_close(asset);
    if(fd>=0){memset(bytes,0,sizeof bytes);ok&=pread(fd,bytes,10,offset)==10&&!memcmp(bytes,"0123456789",10);close(fd);}
    return ok;
}
JNIEXPORT void JNICALL Java_NdkAssetsProbe_verify(JNIEnv *env,jclass type,jobject java_manager,jstring platform_path,jstring loose_path,jstring obb_path,jint density,jint orientation,jstring language){
    (void)type;
    const char *file=(*env)->GetStringUTFChars(env,platform_path,NULL);void *platform=dlopen(file,RTLD_NOW|RTLD_LOCAL|RTLD_FIRST);(*env)->ReleaseStringUTFChars(env,platform_path,file);CHECK(platform);
    void(*set_root)(const char*)=dlsym(platform,"kl_ndk_set_assets_dir");void(*set_obb)(const char*,const char*)=dlsym(platform,"kl_obbmap_init");CHECK(set_root&&set_obb);
    const char *loose=(*env)->GetStringUTFChars(env,loose_path,NULL);set_root(loose);(*env)->ReleaseStringUTFChars(env,loose_path,loose);
    const char *obb=(*env)->GetStringUTFChars(env,obb_path,NULL);set_obb(obb,NULL);(*env)->ReleaseStringUTFChars(env,obb_path,obb);
    AAssetManager *manager=AAssetManager_fromJava(env,java_manager);CHECK(manager);
    AConfiguration *config=AConfiguration_new(),*copy=AConfiguration_new();CHECK(config&&copy);
    AConfiguration_fromAssetManager(config,manager);CHECK(AConfiguration_getDensity(config)==density);CHECK(AConfiguration_getOrientation(config)==orientation);
    char locale[3]={0,0,99};AConfiguration_getLanguage(config,locale);CHECK(locale[2]==99);
    const char *lang=(*env)->GetStringUTFChars(env,language,NULL);int locale_ok=!strncmp(locale,lang,2);(*env)->ReleaseStringUTFChars(env,language,lang);CHECK(locale_ok);
    AConfiguration_copy(copy,config);CHECK(AConfiguration_diff(config,copy)==0&&AConfiguration_match(config,copy));
    #include "configuration-scalar-checks.inc"
    AConfiguration_setLanguage(copy,"en");AConfiguration_getLanguage(copy,locale);CHECK(!memcmp(locale,"en",2)&&locale[2]==99);
    AConfiguration_setCountry(copy,"US");AConfiguration_getCountry(copy,locale);CHECK(!memcmp(locale,"US",2)&&locale[2]==99);
    AConfiguration_delete(copy);AConfiguration_delete(config);
    CHECK(check_asset(manager,"stored.txt",1));CHECK(check_asset(manager,"compressed.txt",0));CHECK(check_asset(manager,"loose.txt",1));CHECK(check_asset(manager,"fixture.bank",1));
    AAsset *empty=AAssetManager_open(manager,"empty.txt",AASSET_MODE_RANDOM);CHECK(empty&&AAsset_getLength64(empty)==0);char byte;CHECK(AAsset_read(empty,&byte,1)==0);AAsset_close(empty);
    CHECK(!AAssetManager_open(manager,"directory",AASSET_MODE_RANDOM));CHECK(!AAssetManager_open(manager,"../outside",AASSET_MODE_RANDOM));
    AAssetDir *directory=AAssetManager_openDir(manager,"nested");CHECK(directory);const char *next=AAssetDir_getNextFileName(directory);CHECK(next&&!strcmp(next,"file.txt"));CHECK(!AAssetDir_getNextFileName(directory));AAssetDir_rewind(directory);CHECK(AAssetDir_getNextFileName(directory));AAssetDir_close(directory);
}

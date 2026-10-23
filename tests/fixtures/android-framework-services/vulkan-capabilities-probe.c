#include <jni.h>
#include <assert.h>
#include <stdio.h>
#include <stddef.h>
#include "vulkan-capabilities.h"

extern jint Java_maclauncher_android_bridge_Graphics_vulkanVersion(JNIEnv *,jclass);
extern jint Java_maclauncher_android_bridge_Graphics_vulkanHardwareLevel(JNIEnv *,jclass);

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *reserved){
    (void)reserved;
    VkPhysicalDeviceFeatures f={0};assert(klj_vulkan_hardware_level(&f)==-1);
    f.textureCompressionETC2=1;assert(klj_vulkan_hardware_level(&f)==0);
    size_t required[]={offsetof(VkPhysicalDeviceFeatures,fullDrawIndexUint32),
        offsetof(VkPhysicalDeviceFeatures,imageCubeArray),offsetof(VkPhysicalDeviceFeatures,independentBlend),
        offsetof(VkPhysicalDeviceFeatures,geometryShader),offsetof(VkPhysicalDeviceFeatures,tessellationShader),
        offsetof(VkPhysicalDeviceFeatures,sampleRateShading),offsetof(VkPhysicalDeviceFeatures,textureCompressionASTC_LDR),
        offsetof(VkPhysicalDeviceFeatures,fragmentStoresAndAtomics),offsetof(VkPhysicalDeviceFeatures,shaderImageGatherExtended),
        offsetof(VkPhysicalDeviceFeatures,shaderUniformBufferArrayDynamicIndexing),offsetof(VkPhysicalDeviceFeatures,shaderSampledImageArrayDynamicIndexing)};
    for(size_t i=0;i<sizeof(required)/sizeof(required[0]);i++)*(VkBool32*)((char*)&f+required[i])=1;
    assert(klj_vulkan_hardware_level(&f)==1);
    for(size_t i=0;i<sizeof(required)/sizeof(required[0]);i++){
        VkBool32 *value=(VkBool32*)((char*)&f+required[i]);*value=0;
        assert(klj_vulkan_hardware_level(&f)==0);*value=1;
    }
    f.textureCompressionETC2=0;assert(klj_vulkan_hardware_level(&f)==-1);
    assert(klj_vulkan_feature_version(VK_MAKE_VERSION(1,0,2))==0);
    assert(klj_vulkan_feature_version(VK_MAKE_VERSION(1,0,68))==VK_MAKE_VERSION(1,0,3));
    assert(klj_vulkan_feature_version(VK_MAKE_VERSION(1,1,357))==VK_MAKE_VERSION(1,1,0));
    JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_8)!=JNI_OK)return JNI_ERR;
    jclass type=(*env)->FindClass(env,"maclauncher/android/bridge/Graphics");if(!type)return JNI_ERR;
    JNINativeMethod methods[]={
        {"vulkanVersion","()I",(void*)Java_maclauncher_android_bridge_Graphics_vulkanVersion},
        {"vulkanHardwareLevel","()I",(void*)Java_maclauncher_android_bridge_Graphics_vulkanHardwareLevel}};
    if((*env)->RegisterNatives(env,type,methods,2)!=JNI_OK)return JNI_ERR;
    jint version=Java_maclauncher_android_bridge_Graphics_vulkanVersion(env,type);
    jint level=Java_maclauncher_android_bridge_Graphics_vulkanHardwareLevel(env,type);
    assert(version!=0&&level>=0);
    printf("Selected Vulkan feature version=%u.%u.%u level=%d\n",VK_VERSION_MAJOR(version),VK_VERSION_MINOR(version),VK_VERSION_PATCH(version),level);
    (*env)->DeleteLocalRef(env,type);return JNI_VERSION_1_8;
}

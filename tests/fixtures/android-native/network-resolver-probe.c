#include <jni.h>
#include <netdb.h>
static int resolutions;
static int counted_getaddrinfo(const char *node,const char *service,const struct addrinfo *hints,struct addrinfo **result){
    resolutions++;return getaddrinfo(node,service,hints,result);
}
#define getaddrinfo counted_getaddrinfo
#include "network-resolver.c"
#undef getaddrinfo
JNIEXPORT jint JNICALL Java_maclauncher_android_net_DnsPolicyProbe_resolutions(JNIEnv *env,jclass owner){
    (void)env;(void)owner;return resolutions;
}

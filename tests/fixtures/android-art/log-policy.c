#include <android/log.h>
#include <dlfcn.h>
#include <stdio.h>

int main(void) {
 const char *tag="MacLauncherLogPolicyProbe";
 int priority=__android_log_get_minimum_priority();
 int verbose=__android_log_is_loggable(ANDROID_LOG_VERBOSE,tag,ANDROID_LOG_INFO);
 int debug=__android_log_is_loggable(ANDROID_LOG_DEBUG,tag,ANDROID_LOG_INFO);
 int info=__android_log_is_loggable(ANDROID_LOG_INFO,tag,ANDROID_LOG_INFO);
 int error=__android_log_is_loggable(ANDROID_LOG_ERROR,tag,ANDROID_LOG_INFO);
 printf("DEFAULT priority=%d verbose=%d debug=%d info=%d error=%d\n",priority,verbose,debug,info,error);
 if(verbose||debug||!info||!error)return 1;
 // Unlike is_loggable(..., INFO), Android's unconditional write API supplies
 // VERBOSE as its fallback. Check the actual physical output as well.
 __android_log_write(ANDROID_LOG_DEBUG,tag,"default debug payload must not persist");
 __android_log_write(ANDROID_LOG_INFO,tag,"ordinary information survives");
 __android_log_write(ANDROID_LOG_WARN,tag,"ordinary warning survives");
 __android_log_set_minimum_priority(ANDROID_LOG_DEBUG);
 void (*initialize)(void)=(void (*)(void))dlsym(RTLD_DEFAULT,"klj_art_log_initialize");
 if(initialize)initialize();
 if(__android_log_get_minimum_priority()!=ANDROID_LOG_DEBUG||
    !__android_log_is_loggable(ANDROID_LOG_DEBUG,tag,ANDROID_LOG_INFO)||
    __android_log_is_loggable(ANDROID_LOG_VERBOSE,tag,ANDROID_LOG_INFO))return 2;
 __android_log_write(ANDROID_LOG_DEBUG,tag,"explicit application debug survives");
 __android_log_write(ANDROID_LOG_ERROR,tag,"ordinary error survives");
 __android_log_set_minimum_priority(ANDROID_LOG_ERROR);
 if(initialize)initialize();
 if(__android_log_get_minimum_priority()!=ANDROID_LOG_ERROR)return 3;
 __android_log_write(ANDROID_LOG_WARN,tag,"explicit error threshold suppresses warning");
 puts("PASS original Android log policy and application selection survive transport initialization");
 return 0;
}

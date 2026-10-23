/* This fixture calls the production JNI boundary with real Java threads and Mach
 * policies. The identity functions only satisfy unrelated module link symbols. */
#include "framework-process.c"
#include "native-process-imports.h"
static void thread_error(JNIEnv* e,kern_return_t code){
    if(code!=KERN_SUCCESS)error(e,"java/lang/AssertionError","Mach scheduling observation failed");
}
uid_t klj_process_uid(void){return getuid();}
gid_t klj_process_gid(void){return getgid();}
int klj_process_setuid(uid_t u){return u==getuid()?0:-1;}
int klj_process_setgid(gid_t g){return g==getgid()?0:-1;}
JNIEXPORT jint JNICALL Java_PriorityProbe_tid(JNIEnv* e,jclass c){return Java_libcore_io_Linux_nativeGettid(e,c);}
JNIEXPORT jint JNICALL Java_PriorityProbe_port(JNIEnv* e,jclass c){(void)e;(void)c;return pthread_mach_thread_np(pthread_self());}
JNIEXPORT jint JNICALL Java_PriorityProbe_references(JNIEnv* e,jclass c,jint port){(void)c;mach_port_urefs_t refs=0;thread_error(e,mach_port_get_refs(mach_task_self(),port,MACH_PORT_RIGHT_SEND,&refs));return refs;}
JNIEXPORT jint JNICALL Java_PriorityProbe_importance(JNIEnv* e,jclass c,jint port){(void)c;thread_precedence_policy_data_t policy;mach_msg_type_number_t size=THREAD_PRECEDENCE_POLICY_COUNT;boolean_t defaults=FALSE;thread_error(e,thread_policy_get(port,THREAD_PRECEDENCE_POLICY,(thread_policy_t)&policy,&size,&defaults));return policy.importance;}
JNIEXPORT jint JNICALL Java_PriorityProbe_qosTier(JNIEnv* e,jclass c,jint port){
    (void)c;integer_t qos[2]={0,0};mach_msg_type_number_t size=2;boolean_t defaults=FALSE;
    // XNU THREAD_QOS_POLICY exposes the requested resource tier and relative
    // importance. Android CPU nice must not install a Darwin background tier.
    thread_error(e,thread_policy_get(port,9,(thread_policy_t)qos,&size,&defaults));return qos[0];
}
JNIEXPORT jint JNICALL Java_PriorityProbe_basePriority(JNIEnv* e,jclass c,jint port){
    (void)c;policy_timeshare_info_data_t policy;mach_msg_type_number_t size=POLICY_TIMESHARE_INFO_COUNT;
    thread_error(e,thread_info(port,THREAD_SCHED_TIMESHARE_INFO,(thread_info_t)&policy,&size));return policy.base_priority;
}
JNIEXPORT void JNICALL Java_PriorityProbe_set(JNIEnv* e,jclass c,jint t,jint v){Java_android_os_Process_setThreadPriority__II(e,c,t,v);}
JNIEXPORT jint JNICALL Java_PriorityProbe_get(JNIEnv* e,jclass c,jint t){return Java_android_os_Process_getThreadPriority(e,c,t);}
JNIEXPORT jint JNICALL Java_PriorityProbe_scheduler__I(JNIEnv* e,jclass c,jint t){return Java_android_os_Process_getThreadScheduler(e,c,t);}
JNIEXPORT void JNICALL Java_PriorityProbe_scheduler__III(JNIEnv* e,jclass c,jint t,jint p,jint v){Java_android_os_Process_setThreadScheduler(e,c,t,p,v);}
JNIEXPORT void JNICALL Java_PriorityProbe_canBackground(JNIEnv* e,jclass c,jboolean v){Java_android_os_Process_setCanSelfBackground(e,c,v);}
JNIEXPORT void JNICALL Java_PriorityProbe_signal(JNIEnv* e,jclass c,jint t){Java_android_os_Process_sendTgSignalThrows(e,c,getpid(),t,0);}
JNIEXPORT void JNICALL Java_ServiceThreadPriorityProbe_install(JNIEnv* e,jclass c){
    (void)c;jclass process=(*e)->FindClass(e,"android/os/Process");if(!process)return;
    JNINativeMethod methods[]={
        {"setCanSelfBackground","(Z)V",(void*)Java_android_os_Process_setCanSelfBackground},
        {"setThreadPriority","(I)V",(void*)Java_android_os_Process_setThreadPriority__I},
        {"setThreadPriority","(II)V",(void*)Java_android_os_Process_setThreadPriority__II}
    };
    (*e)->RegisterNatives(e,process,methods,sizeof(methods)/sizeof(methods[0]));(*e)->DeleteLocalRef(e,process);
}
JNIEXPORT jint JNICALL Java_PriorityProbe_libcSet(JNIEnv* e,jclass c,jint t,jint value){
    (void)e;(void)c;int (*call)(int,id_t,int)=klj_process_abi_lookup("setpriority");
    return call(PRIO_PROCESS,t,value)?errno:0;
}
JNIEXPORT jint JNICALL Java_PriorityProbe_libcGet(JNIEnv* e,jclass c,jint t){
    (void)c;int (*call)(int,id_t)=klj_process_abi_lookup("getpriority");
    errno=0;int value=call(PRIO_PROCESS,t);priority_error(e,errno);return value;
}

JNIEXPORT void JNICALL Java_PriorityProbe_schedulerFamily(JNIEnv *env,jclass type,jint target){
 (void)type;int (*set)(int,int,const klj_process_sched_param*)=klj_process_abi_lookup("sched_setscheduler");
 int (*get)(int)=klj_process_abi_lookup("sched_getscheduler");
 int (*setparam)(int,const klj_process_sched_param*)=klj_process_abi_lookup("sched_setparam");
 int (*getparam)(int,klj_process_sched_param*)=klj_process_abi_lookup("sched_getparam");
 int (*minimum)(int)=klj_process_abi_lookup("sched_get_priority_min"),(*maximum)(int)=klj_process_abi_lookup("sched_get_priority_max");
 int (*interval)(int,struct timespec*)=klj_process_abi_lookup("sched_rr_get_interval");
 #define CHECK(test) if(!(test)){error(env,"java/lang/AssertionError",#test);return;}
 for(int policy=0;policy<=6;policy++)if(policy!=4){CHECK(minimum(policy)==((policy==1||policy==2)?1:0));CHECK(maximum(policy)==((policy==1||policy==2)?99:0));}
 klj_process_sched_param parameter={0};struct timespec quantum={-1,-1};
 for(int policy=0;policy<=5;policy++)if(policy!=4){parameter.priority=(policy==1||policy==2)?37:0;CHECK(set(target,policy,&parameter)==0);CHECK(get(target)==policy);klj_process_sched_param result={-1};CHECK(getparam(target,&result)==0&&result.priority==parameter.priority);CHECK(setparam(target,&parameter)==0);CHECK(interval(target,&quantum)==0&&quantum.tv_sec>=0&&quantum.tv_nsec>=0&&quantum.tv_nsec<1000000000);}
 parameter.priority=0;CHECK(set(target,0x40000000,&parameter)==0&&get(target)==0x40000000);CHECK(set(target,0,&parameter)==0);
 parameter.priority=1;CHECK(set(target,0,&parameter)==-1&&errno==EINVAL);CHECK(set(target,6,&parameter)==-1&&errno==EINVAL);CHECK(get(-1)==-1&&errno==ESRCH);CHECK(getparam(target,NULL)==-1&&errno==EFAULT);
 #undef CHECK
}

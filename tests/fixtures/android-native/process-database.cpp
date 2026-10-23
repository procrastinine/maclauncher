#include <jni.h>
#include "database.h"
#include <assert.h>
#include <initializer_list>
#include <pthread.h>

static const char *root;
extern "C" void *klj_database_lookup(const char *);
extern "C" jint Java_android_os_Process_getUidForName(JNIEnv *,jclass,jstring);
extern "C" jint Java_android_os_Process_getGidForName(JNIEnv *,jclass,jstring);
extern "C" int klj_security_self_access(const char *,const char *){errno=EPERM;return -1;}
static bool pending;
static int acquired,released;
static jint name_id(const char *name,bool group_lookup){
 JNINativeInterface_ functions{};
 functions.GetStringUTFChars=[](JNIEnv *,jstring value,jboolean *)->const char *{acquired++;return reinterpret_cast<const char *>(value);};
 functions.ReleaseStringUTFChars=[](JNIEnv *,jstring value,const char *text){assert(reinterpret_cast<const char *>(value)==text);released++;};
 functions.ExceptionCheck=[](JNIEnv *)->jboolean{return pending?JNI_TRUE:JNI_FALSE;};
 functions.FindClass=[](JNIEnv *,const char *name)->jclass{assert(!strcmp(name,"java/lang/NullPointerException"));return reinterpret_cast<jclass>(1);};
 functions.ThrowNew=[](JNIEnv *,jclass type,const char *)->jint{assert(type==reinterpret_cast<jclass>(1));pending=true;return 0;};
 functions.DeleteLocalRef=[](JNIEnv *,jobject){};
 JNIEnv env{&functions};jstring value=reinterpret_cast<jstring>(const_cast<char *>(name));
 return group_lookup?Java_android_os_Process_getGidForName(&env,nullptr,value):Java_android_os_Process_getUidForName(&env,nullptr,value);
}
extern "C" const char *kl_guest_path(const char *name,char *buffer,size_t size){
 assert(name[0]=='/');assert(snprintf(buffer,size,"%s%s",root,name)<(int)size);return buffer;
}
static int property(const char *name,char *value){assert(!strcmp(name,"ro.product.first_api_level"));strcpy(value,"36");return 2;}
extern "C" void *kl_shim_lookup(const char *name){assert(!strcmp(name,"__system_property_get"));return reinterpret_cast<void*>(&property);}
static void *worker(void *argument){
 uid_t id=(uid_t)(uintptr_t)argument;char expected[32];snprintf(expected,sizeof expected,"u0_a%u",id-10000);
 for(int i=0;i<30;i++){passwd *value=getpwuid(id);assert(value&&value->pw_uid==id);usleep(50);assert(!strcmp(value->pw_name,expected));assert(klj_database_name_id(expected,0)==(int)id);}
 return nullptr;
}
int main(int argc,char **argv){
 assert(argc==2);root=argv[1];
 static_assert(sizeof(passwd)==48&&sizeof(group)==32);
 int native_uid=(int)klj_process_uid();
 gid_t assigned=10042;
 assert(!klj_process_configure_principal(10042,10042,&assigned,1,native_uid));
 assert(klj_process_getgroups(0,nullptr)==1);gid_t membership=0;
 assert(klj_process_getgroups(1,&membership)==1&&membership==10042);
 /* This application principal has no CAP_SETGID, even for its current group. */
 errno=0;assert(initgroups("u0_a42",10042)==-1&&errno==EPERM);errno=0;
 assert(initgroups("root",0)==-1&&errno==EPERM);
 assert(!strcmp(getlogin(),"u0_a42"));
 char login[32];assert(getlogin_r(login,sizeof login)==0&&!strcmp(login,"u0_a42"));
 assert(getlogin_r(login,1)==ERANGE);
 passwd *application=getpwnam("u0_a42");assert(application&&application->pw_uid==10042&&application->pw_gid==10042);
 char saved[32];strcpy(saved,application->pw_name);
 group *internet=getgrnam("inet");assert(internet&&internet->gr_gid==3003);
 assert(!strcmp(application->pw_name,saved));
 assert(getpwuid(0)&&!strcmp(getpwuid(0)->pw_name,"root"));
 assert(getgrgid(10042)&&!strcmp(getgrgid(10042)->gr_name,"u0_a42"));
 passwd *custom=getpwnam("system_fixture");assert(custom&&custom->pw_uid==6001);
 assert(getgrnam("system_fixture")&&getgrnam("system_fixture")->gr_gid==6001);
 assert(name_id("system",false)==1000&&name_id("system",true)==1000);
 assert(name_id("media",false)==1013&&name_id("inet",true)==3003);
 assert(name_id("u0_a42",false)==10042&&name_id("u10_a42",false)==1010042);
 assert(name_id("u0_a42",true)==10042);
 assert(name_id("system_fixture",false)==6001&&name_id("system_fixture",true)==6001);
 for(bool group_lookup:{false,true}){
  assert(name_id("0",group_lookup)==0&&name_id("0001000",group_lookup)==1000);
  assert(name_id("2147483647",group_lookup)==INT_MAX);
  for(const char *unknown:{""," 1000","+1000","-1","1000junk","_windowserver","_maclauncher_missing_account"})assert(name_id(unknown,group_lookup)==-1);
 }
 assert(acquired==released);
 assert(name_id(nullptr,false)==-1&&pending);pending=false;
 assert(name_id(nullptr,true)==-1&&pending);pending=false;
 assert(klj_process_uid()==10042&&klj_process_gid()==10042);
 struct {passwd value;uint64_t guard;} pw={{},0x123456789abcdef0};
 struct {group value;uint64_t guard;} gr={{},0x123456789abcdef0};
 passwd *pw_result=nullptr;group *gr_result=nullptr;char buffer[1024];
 errno=EBUSY;assert(getpwnam_r("u0_a42",&pw.value,buffer,sizeof buffer,&pw_result)==0&&errno==EBUSY);
 assert(pw_result==&pw.value&&pw.value.pw_uid==10042&&pw.guard==0x123456789abcdef0);
 assert(getpwuid_r(10043,&pw.value,buffer,sizeof buffer,&pw_result)==0&&!strcmp(pw.value.pw_name,"u0_a43"));
 assert(getpwnam_r("u0_a42",&pw.value,buffer,1,&pw_result)==ERANGE&&pw_result==nullptr);
 assert(getgrnam_r("inet",&gr.value,buffer,sizeof buffer,&gr_result)==0&&gr_result==&gr.value&&gr.value.gr_gid==3003&&gr.guard==0x123456789abcdef0);
 assert(getgrgid_r(10042,&gr.value,buffer,sizeof buffer,&gr_result)==0&&!strcmp(gr.value.gr_name,"u0_a42"));
 assert(getgrgid_r(10042,&gr.value,buffer,1,&gr_result)==ERANGE&&gr_result==nullptr);
 int count=0;gid_t groups[2]={};assert(getgrouplist("u0_a42",10042,groups,&count)==-1&&count==1);
 assert(getgrouplist("u0_a42",10042,groups,&count)==1&&groups[0]==10042);
 setpwent();setgrent();assert(getpwent()&&getgrent());endpwent();endgrent();
 pthread_t threads[2];for(int i=0;i<2;i++)assert(!pthread_create(threads+i,nullptr,worker,(void*)(uintptr_t)(10042+i)));
 for(auto thread:threads)assert(!pthread_join(thread,nullptr));
 assert(klj_database_lookup("getpwnam_r")==reinterpret_cast<void*>(&getpwnam_r));
 puts("PASS original Bionic account module, Process JNI names, Linux layouts, private files, reentrant buffers, thread isolation and immutable guest credentials");
}

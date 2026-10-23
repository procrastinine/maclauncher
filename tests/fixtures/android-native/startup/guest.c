#include <stdint.h>
__attribute__((visibility("default"))) int startup_status,startup_order,startup_calls;
__attribute__((visibility("default"))) char **startup_expected_argv,**startup_expected_envp;
__attribute__((visibility("default"))) int startup_expected_argc;
static int equal(const char *a,const char *b){while(*a&&*a==*b){a++;b++;}return *a==*b;}
static int check(int argc,char **argv,char **envp,int order){
    startup_calls++;
    if(argc!=startup_expected_argc||argv!=startup_expected_argv||envp!=startup_expected_envp){startup_status=1;return 0;}
    if(argc!=4||argv[4]||envp[3]||!equal(argv[0],"startup.owner")||!equal(argv[2],"")||
       !equal(argv[3],"\xf0\x9f\x8e\xae")||!equal(envp[0],"HOME=/guest/\xe6\xb8\xb8\xe6\x88\x8f")||
       !equal(envp[1],"EMPTY=")||!equal(envp[2],"ANDROID_DATA=/data")){startup_status=2;return 0;}
    if(startup_order!=order-1){startup_status=3;return 0;}
    startup_order=order;return 1;
}
__attribute__((visibility("default"))) void startup_init(int argc,char **argv,char **envp){
    if(check(argc,argv,envp,1)){if(!equal(argv[1],"before"))startup_status=4;else argv[1][0]='B';}
}
static void first(int argc,char **argv,char **envp){if(check(argc,argv,envp,2)&&!equal(argv[1],"Before"))startup_status=5;}
static void second(int argc,char **argv,char **envp){(void)check(argc,argv,envp,3);}
typedef void (*Constructor)(int,char **,char **);
__attribute__((used,section(".init_array"))) static Constructor constructors[]={first,0,(Constructor)(uintptr_t)-1,second};

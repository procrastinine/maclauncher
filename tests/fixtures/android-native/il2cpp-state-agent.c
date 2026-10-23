/* Launch-time-only diagnostic for original managed loading state. It reads
 * primitive fields through IL2CPP's public API; it never changes game state. */
#define Agent_OnLoad ExceptionAgent_OnLoad
#include "il2cpp-exception-agent.c"
#undef Agent_OnLoad
#include <time.h>

#ifndef KLJ_STATE_CLASSES
#define KLJ_STATE_CLASSES "Loading,IRemoteConfigManager,FirebaseRemoteConfigManager"
#endif
static void *(*domain_get)(void), *(*thread_attach)(void*);
static void (*thread_detach)(void*);
static const void **(*domain_assemblies)(void*,size_t*);
static const void *(*assembly_image)(const void*);
static void *(*class_from_name)(const void*,const char*,const char*);
static void *(*class_parent)(void*), *(*class_fields)(void*,void**);
static const char *(*field_name)(void*);
static const void *(*field_type)(void*);
static int (*field_flags)(void*), (*type_kind)(const void*);
static void *(*class_from_type)(const void*);
static int (*class_is_valuetype)(void*);
static void (*field_value)(void*,void*,void*), (*static_value)(void*,void*);
static uint32_t (*hold_object)(void*,int);
static void (*free_object)(uint32_t);
static int selected(const char *name){
    return name && (strstr(name,"Loading")||strstr(name,"RemoteConfig")||strstr(name,"StartupLogin"));
}
static void fields(void *klass,void *object,unsigned depth){
    if(!klass||depth>3)return;
    for(void *k=klass;k;k=class_parent(k)){
        void *cursor=NULL,*field;
        while((field=class_fields(k,&cursor))){
            int flags=field_flags(field),kind=type_kind(field_type(field));
            if(!!(flags&16)!=!object)continue;
            if(kind==17||(kind==21&&class_is_valuetype(class_from_type(field_type(field)))))continue;
            if(!((kind>=2&&kind<=14)||kind==18||kind==21||kind==28||kind==29))continue;
            unsigned char value[16]={0};
            if(object)field_value(object,field,value);else static_value(field,value);
            fprintf(stderr,"[il2cpp-state] %*s%s.%s=",depth*2,"",class_name(k),field_name(field));
            if(kind==2)fprintf(stderr,"%s",value[0]?"true":"false");
            else if(kind>=3&&kind<=11){uint64_t n=0;size_t len=kind<=5?1:kind<=7?2:kind<=9?4:8;memcpy(&n,value,len);fprintf(stderr,"0x%llx",(unsigned long long)n);}
            else if(kind==12){float v;memcpy(&v,value,4);fprintf(stderr,"%g",v);}
            else if(kind==13){double v;memcpy(&v,value,8);fprintf(stderr,"%g",v);}
            else if(kind==18||kind==21||kind==28||kind==29||kind==14){
                void *ref=NULL;memcpy(&ref,value,8);const char *name=ref?class_name(object_class(ref)):NULL;
                fprintf(stderr,"%p (%s)",ref,name?name:"null");
                if(ref&&ref!=object&&selected(name)){uint32_t handle=hold_object(ref,0);fprintf(stderr,"\n");fields(object_class(ref),ref,depth+1);free_object(handle);continue;}
            }else fprintf(stderr,"type %d",kind);
            fprintf(stderr,"\n");
        }
    }
}
static void *state_observe(void *argument){
    char *path=argument;void *library=NULL,*image=NULL;void *(*find)(const char*)=NULL,*(*symbol)(void*,const char*)=NULL;
    for(unsigned attempt=0;attempt<6000&&!image;attempt++){
        if(!library)library=dlopen(path,RTLD_NOLOAD|RTLD_LAZY);
        if(library&&!find){find=dlsym(library,"kl_find_image");symbol=dlsym(library,"kl_sym");}
        if(find&&symbol)image=find("libil2cpp.so");if(!image)usleep(5000);
    }
    free(path);if(!image)return NULL;
#define API(target,name) do { *(void**)&target=symbol(image,"il2cpp_" name);if(!target){fprintf(stderr,"[il2cpp-state] unavailable %s\n",name);return NULL;} } while(0)
    API(domain_get,"domain_get");API(thread_attach,"thread_attach");API(thread_detach,"thread_detach");
    API(domain_assemblies,"domain_get_assemblies");API(assembly_image,"assembly_get_image");API(class_from_name,"class_from_name");
    API(class_parent,"class_get_parent");API(class_fields,"class_get_fields");API(field_name,"field_get_name");
    API(field_type,"field_get_type");API(field_flags,"field_get_flags");API(type_kind,"type_get_type");
    API(class_from_type,"class_from_type");API(class_is_valuetype,"class_is_valuetype");
    API(field_value,"field_get_value");API(static_value,"field_static_get_value");
    API(object_class,"object_get_class");API(class_name,"class_get_name");API(hold_object,"gchandle_new");API(free_object,"gchandle_free");
    /* Let the unmodified VM initialize before attaching this diagnostic thread. */
    sleep(20);void *domain=domain_get();if(!domain)return NULL;void *thread=thread_attach(domain);if(!thread)return NULL;
    for(unsigned sample=0;sample<20;sample++){
        size_t count=0;const void **assemblies=domain_assemblies(domain,&count);
        fprintf(stderr,"[il2cpp-state] sample %u time=%lld assemblies=%zu\n",sample,(long long)time(NULL),count);
        char *names=strdup(KLJ_STATE_CLASSES),*next=NULL;
        for(char *name=strtok_r(names,",",&next);name;name=strtok_r(NULL,",",&next)){
            for(size_t i=0;i<count;i++){void *klass=class_from_name(assembly_image(assemblies[i]),"",name);if(klass){fields(klass,NULL,0);break;}}
        }
        free(names);sleep(5);
    }
    thread_detach(thread);return NULL;
}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){
    jint result=ExceptionAgent_OnLoad(vm,options,reserved);if(result!=JNI_OK)return result;
    char *path=strdup(options);pthread_t thread;if(!path||pthread_create(&thread,NULL,state_observe,path)){free(path);return JNI_ERR;}
    pthread_detach(thread);return JNI_OK;
}

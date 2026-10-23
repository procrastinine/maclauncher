#ifdef WEAK_TARGET
#define TARGET __attribute__((weak_import))
#else
#define TARGET
#endif
extern int scope_same(void) TARGET;
extern int JNI_CreateJavaVM(void**,void**,void*) TARGET;
static int replaced(void){return 909;}
static int create(void **vm,void **env,void *arguments){(void)vm;(void)env;(void)arguments;return -19;}
__attribute__((used,section("__DATA,__interpose")))static const struct{const void*replacement,*original;} mappings[]={
 {(void*)replaced,(void*)scope_same},{(void*)create,(void*)JNI_CreateJavaVM}
};

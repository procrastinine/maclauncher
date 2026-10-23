extern int cycle_b;
int cycle_a=7;
__attribute__((constructor)) static void begin(void){cycle_a+=cycle_b;}
int group_value(void){return cycle_a+cycle_b;}
int Java_ArtSharedJniProbe_dependency(void *environment,void *type){(void)environment;(void)type;return cycle_a;}

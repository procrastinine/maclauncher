extern int cycle_a;
int cycle_b=11;
int *cycle_peer=&cycle_a;
__attribute__((constructor)) static void begin(void){cycle_b++;}
int peer_value(void){return *cycle_peer;}

__thread int tls_initialized=37;
__thread unsigned char tls_zero[73] __attribute__((aligned(64)));
__thread int tls_hidden __attribute__((visibility("hidden")))=11;
extern __thread int tls_dependency;
extern __thread int tls_weak __attribute__((weak));

int *tls_address(void){return &tls_initialized;}
unsigned char *tls_zero_address(void){return tls_zero;}
int *tls_hidden_address(void){return &tls_hidden;}
int *tls_dependency_address(void){return &tls_dependency;}
int *tls_weak_address(void){return &tls_weak;}
int tls_increment(int amount){tls_initialized+=amount;return tls_initialized;}
void *tls_thread_pointer(void){void *value;__asm__("mrs %0,tpidr_el0":"=r"(value));return value;}

extern int relro_observe(const void *,const void *);
int writable_value=17;
void *const relocated[8192] __attribute__((section(".data.rel.ro")))={&writable_value};
int constructor_result;
void write_slot(void **slot){*(void *volatile *)slot=0;}
__attribute__((constructor)) static void initialize(void) {
    constructor_result=relocated[0]==&writable_value && *(int *)relocated[0]==17
        ? relro_observe(relocated,&writable_value) : -1;
    ++writable_value;
}

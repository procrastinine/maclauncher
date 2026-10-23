/* Original Android ELF entry into the existing signal-frame owner. */
static void (*observe)(int,void*,void*);
__attribute__((visibility("default"))) void inline_signal_configure(void (*callback)(int,void*,void*)){
    observe=callback;
}
__attribute__((visibility("default"))) void inline_signal_handler(int signal,void *info,void *context){
    observe(signal,info,context);
}

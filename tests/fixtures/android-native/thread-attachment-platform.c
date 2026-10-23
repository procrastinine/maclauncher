#include <jni.h>
#include <stdint.h>
extern int klj_process_ids_configure(const char *);
int klj_test_configure_ids(const char *root){return klj_process_ids_configure(root);}
// This no-window fixture's callbacks are native Mach-O functions. Production
// uses the process ELF image owner for this classification and class lookup.
int klj_guest_address(const void *address){(void)address;return 0;}
jclass klj_find_from_image(JNIEnv *env,const char *name,uintptr_t caller){(void)caller;return (*env)->FindClass(env,name);}

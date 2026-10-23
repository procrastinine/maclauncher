// The focused native probe links the actual generated preferences translation
// unit against the existing runtime, selecting only that unit's binding table.
#include "kl_jni_int.h"
const klj_binding *const klj_preference_test_tables[]={klj_bind_prefs,NULL};

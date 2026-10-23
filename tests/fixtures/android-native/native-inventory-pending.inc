JNIEXPORT jobjectArray JNICALL Java_maclauncher_android_bridge_Probe_pending(JNIEnv *env,jclass ignored,jclass target,jthrowable failure){(*env)->Throw(env,failure);return Java_maclauncher_android_bridge_NativeBinding_nativeMethods(env,ignored,target);}


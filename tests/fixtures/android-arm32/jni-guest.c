#include <jni.h>
typedef struct ANativeWindow ANativeWindow;
extern ANativeWindow *ANativeWindow_fromSurface(JNIEnv *,jobject);
extern jobject ANativeWindow_toSurface(JNIEnv *,ANativeWindow *);
#define CHECK(condition)                                                       \
  do {                                                                         \
    if (!(condition))                                                          \
      return __LINE__;                                                         \
  } while (0)
static JavaVM *saved_vm;
JNIEXPORT jobject guest_c_entry(unsigned marker,JNIEnv *e,jobject text,
                                unsigned long long wide,JavaVM *vm) {
  JNIEnv *actual=0;
  if(marker!=73||wide!=0xfedcba9876543210ULL||vm!=saved_vm||
     (*vm)->GetEnv(vm,(void **)&actual,JNI_VERSION_1_6)!=JNI_OK||actual!=e)return 0;
  return (*e)->NewLocalRef(e,text);
}
JNIEXPORT int guest_native_thread(void) {
  JNIEnv *e=0;
  CHECK((*saved_vm)->GetEnv(saved_vm,(void **)&e,JNI_VERSION_1_6)==JNI_EDETACHED);
  CHECK((*saved_vm)->AttachCurrentThread(saved_vm,(void **)&e,0)==JNI_OK);
  CHECK((*e)->FindClass(e,"java/lang/String"));
  CHECK((*e)->NewStringUTF(e,"native callback"));
  CHECK(!(*e)->ExceptionCheck(e));
  CHECK((*saved_vm)->DetachCurrentThread(saved_vm)==JNI_OK);
  return 0;
}
JNIEXPORT void guest_utf_region(JNIEnv *e, jclass unused, jint destination) {
  (void)unused;
  jstring string = (*e)->NewStringUTF(e, "a");
  (*e)->GetStringUTFRegion(e, string, 0, 1, (char *)(unsigned)destination);
}
static jlong native_roundtrip(JNIEnv *e, jclass type, jlong value,
                              jfloat single, jdouble wide, jstring text,
                              jintArray values) {
  (void)type;
  union {
    jfloat f;
    unsigned i;
  } a = {single};
  union {
    jdouble d;
    unsigned long long i;
  } b = {wide};
  if (a.i != 0x3fa00000 || b.i != 0x400c000000000000ULL)
    return -1;
  const char *chars = (*e)->GetStringUTFChars(e, text, 0);
  if (chars[0] != 'c')
    return -2;
  (*e)->ReleaseStringUTFChars(e, text, chars);
  jint *elements = (*e)->GetIntArrayElements(e, values, 0);
  jint sum = elements[0] + elements[1];
  elements[0] = 31;
  (*e)->ReleaseIntArrayElements(e, values, elements, 0);
  return value + sum;
}
JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  (void)reserved;
  saved_vm = vm;
  JNIEnv *e = 0;
  if ((*vm)->GetEnv(vm, (void **)&e, JNI_VERSION_1_6) != JNI_OK)
    return JNI_ERR;
  jclass type = (*e)->FindClass(e, "Arm32JniFixture");
  if (!type)
    return JNI_ERR;
  JNINativeMethod method = {"nativeRoundtrip", "(JFDLjava/lang/String;[I)J",
                            (void *)native_roundtrip};
  if ((*e)->RegisterNatives(e, type, &method, 1) != 0)
    return JNI_ERR;
  return JNI_VERSION_1_6;
}
static jlong call_v(JNIEnv *e, jclass type, jmethodID id, ...) {
  va_list args;
  va_start(args, id);
  jlong value = (*e)->CallStaticLongMethodV(e, type, id, args);
  va_end(args);
  return value;
}
JNIEXPORT jint guest_probe(JNIEnv *e, jclass unused) {
  (void)unused;
  CHECK((*e)->GetVersion(e) >= JNI_VERSION_1_6);
  JavaVM *vm = 0;
  CHECK((*e)->GetJavaVM(e, &vm) == JNI_OK && vm == saved_vm);
  jclass type = (*e)->FindClass(e, "Arm32JniFixture");
  CHECK(type);
  jmethodID ctor = (*e)->GetMethodID(e, type, "<init>", "(I)V");
  CHECK(ctor);
  jobject object = (*e)->NewObject(e, type, ctor, 13);
  CHECK(object);
  ANativeWindow *window=ANativeWindow_fromSurface(e,object);
  CHECK(window);
  jobject same=ANativeWindow_toSurface(e,window);
  CHECK(same&&(*e)->IsSameObject(e,object,same));
  (*e)->DeleteLocalRef(e,same);
  jfieldID field = (*e)->GetFieldID(e, type, "value", "I");
  CHECK(field);
  CHECK((*e)->GetIntField(e, object, field) == 13);
  (*e)->SetIntField(e, object, field, 29);
  CHECK((*e)->GetIntField(e, object, field) == 29);
  jobject global = (*e)->NewGlobalRef(e, object);
  jweak weak = (*e)->NewWeakGlobalRef(e, global);
  CHECK((*e)->IsSameObject(e, global, weak));
  CHECK((*e)->PushLocalFrame(e, 8) == JNI_OK);
  jobject local = (*e)->NewLocalRef(e, global);
  local = (*e)->PopLocalFrame(e, local);
  CHECK((*e)->IsSameObject(e, local, global));
  (*e)->DeleteLocalRef(e, local);
  (*e)->DeleteWeakGlobalRef(e, weak);
  (*e)->DeleteGlobalRef(e, global);
  jmethodID mixed = (*e)->GetStaticMethodID(e, type, "mixed", "(JFDI)J");
  CHECK(mixed);
  jlong base = 0x123456789abcdef0LL;
  CHECK((*e)->CallStaticLongMethod(e, type, mixed, base, 1.25, 3.5, 17) ==
        base + 19);
  CHECK(call_v(e, type, mixed, base, 1.25, 3.5, 17) == base + 19);
  jvalue arguments[4];
  arguments[0].j = base;
  arguments[1].f = 1.25f;
  arguments[2].d = 3.5;
  arguments[3].i = 17;
  CHECK((*e)->CallStaticLongMethodA(e, type, mixed, arguments) == base + 19);
  jintArray array = (*e)->NewIntArray(e, 3);
  jint values[3] = {4, 5, 6};
  (*e)->SetIntArrayRegion(e, array, 0, 3, values);
  jint *elements = (*e)->GetIntArrayElements(e, array, 0);
  CHECK(elements[1] == 5);
  elements[1] = 17;
  (*e)->ReleaseIntArrayElements(e, array, elements, JNI_COMMIT);
  elements[2] = 29;
  (*e)->ReleaseIntArrayElements(e, array, elements, 0);
  jint *critical = (*e)->GetPrimitiveArrayCritical(e, array, 0);
  CHECK(critical[1] == 17 && critical[2] == 29);
  critical[0] = 37;
  (*e)->ReleasePrimitiveArrayCritical(e, array, critical, 0);
  (*e)->GetIntArrayRegion(e, array, 0, 3, values);
  CHECK(values[0] == 37);
  jobject buffer = (*e)->NewDirectByteBuffer(e, values, sizeof(values));
  CHECK(buffer);
  CHECK((*e)->GetDirectBufferAddress(e, buffer) == values);
  CHECK((*e)->GetDirectBufferCapacity(e, buffer) == sizeof(values));
  jstring string = (*e)->NewStringUTF(e, "guest text");
  const char *chars = (*e)->GetStringUTFChars(e, string, 0);
  CHECK(chars[0] == 'g' && chars[9] == 't');
  (*e)->ReleaseStringUTFChars(e, string, chars);
  const jchar *wide = (*e)->GetStringCritical(e, string, 0);
  CHECK(wide[0] == 'g');
  (*e)->ReleaseStringCritical(e, string, wide);
  jmethodID nested = (*e)->GetStaticMethodID(e, type, "invokeNative", "()J");
  CHECK(nested);
  CHECK((*e)->CallStaticLongMethod(e, type, nested) == base + 18);
  jmethodID floats = (*e)->GetStaticMethodID(e,type,"floats","()Ljava/nio/FloatBuffer;");
  jobject typed = (*e)->CallStaticObjectMethod(e,type,floats);
  unsigned *typed_data = (*e)->GetDirectBufferAddress(e,typed);
  CHECK((*e)->GetDirectBufferCapacity(e,typed)==5 && typed_data[4]==0x42200000u);
  CHECK(!(*e)->ExceptionCheck(e));
  return 0;
}
JNIEXPORT jstring guest_string(JNIEnv *e, jclass type) {
  (void)type;
  return (*e)->NewStringUTF(e, "ARM32 through original JVM");
}

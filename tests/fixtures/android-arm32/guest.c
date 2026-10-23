typedef unsigned int u32;
typedef unsigned long long u64;
extern void *memcpy(void *, const void *, unsigned);
extern int gettid(void);
static volatile u32 initialized;
static const char source[] = "ARM32 bytes through shared libc";
static char copied[sizeof source];
__attribute__((constructor)) static void initialize(void) { initialized++; }
u32 constructor_count(void) { return initialized; }
u64 aligned_arguments(u32 a, u64 b, u32 c) { return b + (u64)a + c; }
typedef struct { u32 first, second; } WordRecord;
_Static_assert(sizeof(WordRecord)==8 && _Alignof(WordRecord)==4,"AAPCS32 word record");
u32 word_record(u32 prefix, WordRecord record, u32 suffix) {
  return prefix+3*record.first+7*record.second+11*suffix;
}
u32 split_record(u32 first,u32 second,u32 third,WordRecord record,u32 suffix) {
  return first+2*second+3*third+5*record.first+7*record.second+11*suffix;
}
u32 shared_copy(void) {
  memcpy(copied, source, sizeof source);
  return copied[0] + copied[sizeof source - 1];
}
u32 shared_thread(void) { return (u32)gettid(); }
float neon_float(float a, float b) { return a * b + 3.0f; }
u32 callback_guest(u32 a) { return a * 7 + 1; }
extern u32 nested_call(u32 (*)(u32), u32);
u32 callback_host(u32 a) { return nested_call(callback_guest, a) + 2; }

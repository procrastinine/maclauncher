#include <dlfcn.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define CHECK(expression) do { if (!(expression)) { \
    fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #expression); exit(1); \
} } while (0)

/* Bionic libc/include/bits/pthread_types.h, pthread.h and linux/sched.h.
 * Host pthread_attr_t, constants and sched_param have different ABIs. */
typedef struct {
    uint32_t flags;
    void *stack_base;
    size_t stack_size, guard_size;
    int32_t sched_policy, sched_priority;
    char reserved[16];
} GuestAttr;
typedef struct { int sched_priority; } GuestParam;
enum {
    G_JOINABLE = 0, G_DETACHED = 1, G_EXPLICIT = 0, G_INHERIT = 1,
    G_SYSTEM = 0, G_PROCESS = 1, G_NORMAL = 0, G_FIFO = 1, G_RR = 2,
    G_FLAG_DETACHED = 1, G_FLAG_INHERIT = 4, G_FLAG_EXPLICIT = 8,
    G_EINVAL = 22, G_ENOTSUP = 95, G_STACK_MIN = 16384,
    G_DEFAULT_STACK = 1024 * 1024 - 32 * 1024
};
_Static_assert(sizeof(GuestAttr) == 56, "Bionic LP64 pthread_attr_t size");
_Static_assert(offsetof(GuestAttr, stack_base) == 8, "Bionic stack offset");
_Static_assert(offsetof(GuestAttr, sched_priority) == 36, "Bionic priority offset");
_Static_assert(sizeof(GuestParam) == 4, "Bionic sched_param has only priority");

#define COOKIE UINT64_C(0xc1b2a39485766758)
typedef struct { uint64_t before; GuestAttr value; uint64_t after; } AttrBox;
typedef struct { uint32_t before; GuestParam value; uint32_t after[4]; } ParamBox;
static AttrBox attr_box(void) {
    AttrBox result;
    memset(&result, 0xa5, sizeof result);
    result.before = result.after = COOKIE;
    return result;
}
static void check_attr_box(const AttrBox *box) {
    CHECK(box->before == COOKIE && box->after == COOKIE);
}
static ParamBox param_box(int priority) {
    ParamBox result;
    memset(&result, 0x5a, sizeof result);
    result.value.sched_priority = priority;
    return result;
}
static void check_param_box(const ParamBox *box) {
    CHECK(box->before == UINT32_C(0x5a5a5a5a));
    for (size_t i = 0; i < sizeof box->after / sizeof box->after[0]; ++i)
        CHECK(box->after[i] == UINT32_C(0x5a5a5a5a));
}

static int (*attr_init)(GuestAttr *), (*attr_destroy)(GuestAttr *);
static int (*attr_getdetachstate)(const GuestAttr *, int *);
static int (*attr_setdetachstate)(GuestAttr *, int);
static int (*attr_getguardsize)(const GuestAttr *, size_t *);
static int (*attr_setguardsize)(GuestAttr *, size_t);
static int (*attr_getinheritsched)(const GuestAttr *, int *);
static int (*attr_setinheritsched)(GuestAttr *, int);
static int (*attr_getschedparam)(const GuestAttr *, GuestParam *);
static int (*attr_setschedparam)(GuestAttr *, const GuestParam *);
static int (*attr_getschedpolicy)(const GuestAttr *, int *);
static int (*attr_setschedpolicy)(GuestAttr *, int);
static int (*attr_getscope)(const GuestAttr *, int *);
static int (*attr_setscope)(GuestAttr *, int);
static int (*attr_getstack)(const GuestAttr *, void **, size_t *);
static int (*attr_setstack)(GuestAttr *, void *, size_t);
static int (*attr_getstacksize)(const GuestAttr *, size_t *);
static int (*attr_setstacksize)(GuestAttr *, size_t);
static int (*guest_getattr)(pthread_t, GuestAttr *);
static int (*guest_create)(pthread_t *, const GuestAttr *, void *(*)(void *), void *);
static int (*guest_join)(pthread_t, void **), (*guest_detach)(pthread_t);
static int (*guest_getschedparam)(pthread_t, int *, GuestParam *);

static void *library;
static void *(*lookup)(const char *);
static void *resolve(const char *name) {
    char exported[96];
    CHECK(snprintf(exported, sizeof exported, "klb_%s", name) < (int)sizeof exported);
    void *direct = dlsym(library, exported), *guest = lookup(name);
    if (!direct || !guest) fprintf(stderr, "Missing guest symbol %s\n", name);
    CHECK(direct && guest && direct == guest);
    return guest;
}
#define LOAD_ATTR(suffix) attr_##suffix = resolve("pthread_attr_" #suffix)

static void check_attribute_family(void) {
    AttrBox box = attr_box();
    GuestAttr *attr = &box.value;
    CHECK(attr_init(attr) == 0);
    check_attr_box(&box);
    CHECK(attr->flags == 0 && attr->stack_base == NULL);
    CHECK(attr->stack_size == G_DEFAULT_STACK && attr->guard_size == (size_t)getpagesize());
    CHECK(attr->sched_policy == G_NORMAL && attr->sched_priority == 0);
    /* The original initializer leaves the ABI reserve intact. */
    for (size_t i = 0; i < sizeof attr->reserved; ++i) CHECK((unsigned char)attr->reserved[i] == 0xa5);
    int flag = -1;
    CHECK(attr_getdetachstate(attr, &flag) == 0 && flag == G_JOINABLE);
    CHECK(attr_getinheritsched(attr, &flag) == 0 && flag == G_INHERIT);
    CHECK(attr_setdetachstate(attr, G_DETACHED) == 0);
    CHECK(attr_getdetachstate(attr, &flag) == 0 && flag == G_DETACHED);
    CHECK(attr->flags == G_FLAG_DETACHED);
    CHECK(attr_setinheritsched(attr, G_EXPLICIT) == 0);
    CHECK(attr_getinheritsched(attr, &flag) == 0 && flag == G_EXPLICIT);
    CHECK(attr->flags == (G_FLAG_DETACHED | G_FLAG_EXPLICIT));
    CHECK(attr_setinheritsched(attr, G_INHERIT) == 0);
    CHECK(attr_getinheritsched(attr, &flag) == 0 && flag == G_INHERIT);
    CHECK(attr->flags == (G_FLAG_DETACHED | G_FLAG_INHERIT));
    GuestAttr saved = *attr;
    CHECK(attr_setdetachstate(attr, 77) == G_EINVAL);
    CHECK(attr_setinheritsched(attr, 77) == G_EINVAL);
    CHECK(memcmp(attr, &saved, sizeof saved) == 0);
    CHECK(attr_setdetachstate(attr, G_JOINABLE) == 0);
    CHECK(attr->flags == G_FLAG_INHERIT);

    CHECK(attr_init(attr) == 0);
    CHECK(attr_setschedpolicy(attr, G_FIFO) == 0);
    CHECK(attr_getschedpolicy(attr, &flag) == 0 && flag == G_FIFO);
    CHECK(attr_getinheritsched(attr, &flag) == 0 && flag == G_EXPLICIT);
    CHECK(attr_setschedpolicy(attr, G_NORMAL) == 0);
    CHECK(attr_getinheritsched(attr, &flag) == 0 && flag == G_INHERIT);
    /* Upstream setters store values; pthread_create validates host support. */
    CHECK(attr_setschedpolicy(attr, 12345) == 0);
    CHECK(attr_getschedpolicy(attr, &flag) == 0 && flag == 12345);
    CHECK(attr_setschedpolicy(attr, G_RR) == 0);
    ParamBox input = param_box(17), output = param_box(-1);
    CHECK(attr_setschedparam(attr, &input.value) == 0);
    CHECK(attr_getschedparam(attr, &output.value) == 0);
    CHECK(output.value.sched_priority == 17 && attr->sched_priority == 17);
    check_param_box(&input); check_param_box(&output);

    CHECK(attr_getscope(attr, &flag) == 0 && flag == G_SYSTEM);
    CHECK(attr_setscope(attr, G_SYSTEM) == 0);
    CHECK(attr_setscope(attr, G_PROCESS) == G_ENOTSUP);
    CHECK(attr_setscope(attr, 77) == G_EINVAL);
    size_t size = 0;
    CHECK(attr_setguardsize(attr, 12345) == 0);
    CHECK(attr_getguardsize(attr, &size) == 0 && size == 12345);
    CHECK(attr_setstacksize(attr, G_STACK_MIN - 1) == G_EINVAL);
    CHECK(attr_setstacksize(attr, G_STACK_MIN + 1) == 0);
    CHECK(attr_getstacksize(attr, &size) == 0 && size == G_STACK_MIN + 1);
    size_t stack_size = 2 * 1024 * 1024;
    void *stack = mmap(NULL, stack_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    CHECK(stack != MAP_FAILED);
    CHECK(attr_setstack(attr, (char *)stack + 1, stack_size) == G_EINVAL);
    CHECK(attr_setstack(attr, stack, stack_size - 1) == G_EINVAL);
    CHECK(attr_setstack(attr, stack, G_STACK_MIN - 1) == G_EINVAL);
    CHECK(attr_setstack(attr, stack, stack_size) == 0);
    void *base = NULL;
    CHECK(attr_getstack(attr, &base, &size) == 0 && base == stack && size == stack_size);
    CHECK(attr_getstacksize(attr, &size) == 0 && size == stack_size);
    CHECK(munmap(stack, stack_size) == 0);
    check_attr_box(&box);
    CHECK(attr_destroy(attr) == 0);
    check_attr_box(&box);
    const unsigned char *bytes = (const unsigned char *)attr;
    for (size_t i = 0; i < sizeof *attr; ++i) CHECK(bytes[i] == 0x42);
}

typedef struct {
    _Atomic int ready, release, done;
    AttrBox snapshot;
    ParamBox parameters;
    int policy;
    uintptr_t local_address;
    void *return_value;
} Worker;
static void wait_for(_Atomic int *value) {
    struct timespec start, now;
    CHECK(clock_gettime(CLOCK_MONOTONIC, &start) == 0);
    while (!atomic_load_explicit(value, memory_order_acquire)) {
        CHECK(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
        CHECK(now.tv_sec - start.tv_sec < 20);
        sched_yield();
    }
}
static void *worker_main(void *opaque) {
    Worker *worker = opaque;
    char marker;
    worker->local_address = (uintptr_t)&marker;
    worker->snapshot = attr_box();
    worker->parameters = param_box(-1);
    CHECK(guest_getattr(pthread_self(), &worker->snapshot.value) == 0);
    CHECK(guest_getschedparam(pthread_self(), &worker->policy, &worker->parameters.value) == 0);
    check_attr_box(&worker->snapshot);
    check_param_box(&worker->parameters);
    atomic_store_explicit(&worker->ready, 1, memory_order_release);
    wait_for(&worker->release);
    void *result = worker->return_value;
    atomic_store_explicit(&worker->done, 1, memory_order_release);
    return result;
}
static GuestAttr live_snapshot(pthread_t thread, Worker *worker, int detached) {
    wait_for(&worker->ready);
    AttrBox snapshot = attr_box();
    CHECK(guest_getattr(thread, &snapshot.value) == 0);
    check_attr_box(&snapshot);
    int flag = -1;
    CHECK(attr_getdetachstate(&snapshot.value, &flag) == 0 && flag == detached);
    void *base = NULL;
    size_t size = 0;
    CHECK(attr_getstack(&snapshot.value, &base, &size) == 0);
    CHECK(base && size && worker->local_address >= (uintptr_t)base);
    CHECK(worker->local_address - (uintptr_t)base < size);
    CHECK(base == worker->snapshot.value.stack_base && size == worker->snapshot.value.stack_size);
    return snapshot.value;
}
static void release_worker(Worker *worker) {
    atomic_store_explicit(&worker->release, 1, memory_order_release);
    wait_for(&worker->done);
}
static void check_live_threads(void) {
    AttrBox main_attr = attr_box();
    CHECK(guest_getattr(pthread_self(), &main_attr.value) == 0);
    check_attr_box(&main_attr);
    CHECK(main_attr.value.stack_base && main_attr.value.stack_size);
    uintptr_t main_local = (uintptr_t)&main_attr;
    CHECK(main_local >= (uintptr_t)main_attr.value.stack_base);
    CHECK(main_local - (uintptr_t)main_attr.value.stack_base < main_attr.value.stack_size);
    ParamBox creator = param_box(-1);
    int creator_policy = -1;
    CHECK(guest_getschedparam(pthread_self(), &creator_policy, &creator.value) == 0);
    check_param_box(&creator);

    AttrBox attributes = attr_box();
    CHECK(attr_init(&attributes.value) == 0);
    CHECK(attr_setguardsize(&attributes.value, 2 * (size_t)getpagesize()) == 0);
    CHECK(attr_setschedpolicy(&attributes.value, G_FIFO) == 0);
    ParamBox requested = param_box(17);
    CHECK(attr_setschedparam(&attributes.value, &requested.value) == 0);
    CHECK(attr_setinheritsched(&attributes.value, G_INHERIT) == 0);
    Worker inherited = {.return_value = (void *)(uintptr_t)0x1234};
    pthread_t thread;
    CHECK(guest_create(&thread, &attributes.value, worker_main, &inherited) == 0);
    GuestAttr actual = live_snapshot(thread, &inherited, G_JOINABLE);
    CHECK(actual.guard_size == 2 * (size_t)getpagesize());
    int flag = -1;
    CHECK(attr_getinheritsched(&actual, &flag) == 0 && flag == G_INHERIT);
    CHECK(inherited.policy == creator_policy);
    CHECK(inherited.parameters.value.sched_priority == creator.value.sched_priority);
    release_worker(&inherited);
    void *result = NULL;
    CHECK(guest_join(thread, &result) == 0 && result == inherited.return_value);

    CHECK(attr_init(&attributes.value) == 0);
    size_t stack_size = 2 * 1024 * 1024;
    void *stack = mmap(NULL, stack_size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    CHECK(stack != MAP_FAILED);
    CHECK(attr_setstack(&attributes.value, stack, stack_size) == 0);
    CHECK(attr_setguardsize(&attributes.value, 0) == 0);
    CHECK(attr_setinheritsched(&attributes.value, G_EXPLICIT) == 0);
    Worker provided = {0};
    CHECK(guest_create(&thread, &attributes.value, worker_main, &provided) == 0);
    actual = live_snapshot(thread, &provided, G_JOINABLE);
    CHECK(actual.stack_base == stack && actual.stack_size == stack_size && actual.guard_size == 0);
    CHECK(attr_getinheritsched(&actual, &flag) == 0 && flag == G_EXPLICIT);
    CHECK(provided.policy == G_NORMAL && provided.parameters.value.sched_priority == 0);
    release_worker(&provided);
    CHECK(guest_join(thread, NULL) == 0);
    CHECK(munmap(stack, stack_size) == 0);

    CHECK(attr_init(&attributes.value) == 0);
    CHECK(attr_setdetachstate(&attributes.value, G_DETACHED) == 0);
    Worker detached_at_start = {0};
    CHECK(guest_create(&thread, &attributes.value, worker_main, &detached_at_start) == 0);
    live_snapshot(thread, &detached_at_start, G_DETACHED);
    release_worker(&detached_at_start);

    CHECK(attr_setdetachstate(&attributes.value, G_JOINABLE) == 0);
    Worker detached_live = {0};
    CHECK(guest_create(&thread, &attributes.value, worker_main, &detached_live) == 0);
    live_snapshot(thread, &detached_live, G_JOINABLE);
    CHECK(guest_detach(thread) == 0);
    live_snapshot(thread, &detached_live, G_DETACHED);
    release_worker(&detached_live);
    check_attr_box(&attributes);
    CHECK(attr_destroy(&attributes.value) == 0);
    check_attr_box(&attributes);
}

int main(int argc, char **argv) {
    CHECK(argc == 3);
    library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    // Android thread IDs are leases in the supervisor's private namespace.
    int (*configure)(const char *) = (int (*)(const char *))dlsym(library, "klj_process_ids_configure");
    CHECK(configure && configure(argv[2]) > 0);
    lookup = dlsym(library, "kl_shim_lookup");
    CHECK(lookup);
    LOAD_ATTR(init); LOAD_ATTR(destroy);
    LOAD_ATTR(getdetachstate); LOAD_ATTR(setdetachstate);
    LOAD_ATTR(getguardsize); LOAD_ATTR(setguardsize);
    LOAD_ATTR(getinheritsched); LOAD_ATTR(setinheritsched);
    LOAD_ATTR(getschedparam); LOAD_ATTR(setschedparam);
    LOAD_ATTR(getschedpolicy); LOAD_ATTR(setschedpolicy);
    LOAD_ATTR(getscope); LOAD_ATTR(setscope);
    LOAD_ATTR(getstack); LOAD_ATTR(setstack);
    LOAD_ATTR(getstacksize); LOAD_ATTR(setstacksize);
    guest_getattr = resolve("pthread_getattr_np");
    guest_create = resolve("pthread_create");
    guest_join = resolve("pthread_join");
    guest_detach = resolve("pthread_detach");
    guest_getschedparam = resolve("pthread_getschedparam");
    check_attribute_family();
    check_live_threads();
    puts("PASS complete Bionic pthread attributes, scheduling ABI, supplied stacks, inheritance and live detach state");
    return 0;
}

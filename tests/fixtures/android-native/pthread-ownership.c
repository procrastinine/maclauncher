#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static unsigned old_hash(uintptr_t address) {
    return (unsigned)(((address >> 4) * UINT64_C(0x9E3779B97F4A7C15)) >> 49);
}
static int (*lock_guest)(void *), (*unlock_guest)(void *);
static unsigned char shared_mutex[64];
static unsigned shared_count;
static int (*wait_guest)(void *, void *);
static unsigned char shared_condition[64];
static _Atomic int waiting;
static void unlock_cancelled(void *mutex) { assert(unlock_guest(mutex) == 0); }
static void *sleep_until_cancelled(void *unused) {
    (void)unused;
    assert(lock_guest(shared_mutex) == 0);
    pthread_cleanup_push(unlock_cancelled, shared_mutex);
    atomic_store(&waiting, 1);
    for (;;) assert(wait_guest(shared_condition, shared_mutex) == 0);
    pthread_cleanup_pop(1);
    return NULL;
}
static void *contend(void *unused) {
    (void)unused;
    for (unsigned i = 0; i < 1000; ++i) {
        assert(lock_guest(shared_mutex) == 0);
        ++shared_count;
        assert(unlock_guest(shared_mutex) == 0);
    }
    return NULL;
}

int main(int argc, char **argv) {
    assert(argc == 3);
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    // Android thread IDs are leases in the supervisor's private namespace.
    int (*configure)(const char *) = dlsym(library, "klj_process_ids_configure");
    assert(configure && configure(argv[2]) > 0);
    void *(*resolve)(const char *) = dlsym(library, "kl_shim_lookup");
    assert(resolve);
    int (*initialize)(void *, const void *) = dlsym(library, "klb_pthread_mutex_init");
    int (*lock)(void *) = dlsym(library, "klb_pthread_mutex_lock");
    int (*unlock)(void *) = dlsym(library, "klb_pthread_mutex_unlock");
    int (*destroy)(void *) = dlsym(library, "klb_pthread_mutex_destroy");
    assert(initialize && lock && unlock && destroy);

    unsigned char *storage = calloc(131072, 64);
    void **seen = calloc(32768, sizeof(void *));
    assert(storage && seen);
    void *first = NULL, *second = NULL;
    for (size_t i = 0; i < 131072; ++i) {
        void *address = storage + i * 64;
        unsigned hash = old_hash((uintptr_t)address);
        if (seen[hash]) { first = seen[hash]; second = address; break; }
        seen[hash] = address;
    }
    assert(first && second);
    assert(initialize(first, NULL) == 0);
    int recursive = 1;
    assert(initialize(second, NULL) == 0);
    assert(lock(second) == 0);
    assert(destroy(first) == 0);
    int result = unlock(second);
    if (result) { fprintf(stderr, "Live colliding mutex lost after unrelated destroy: unlock=%d\n", result); return 1; }
    assert(destroy(second) == 0);
    assert(initialize(second, &recursive) == 0);
    assert(lock(second) == 0 && lock(second) == 0);
    assert(destroy(second) == EBUSY);
    assert(unlock(second) == 0 && destroy(second) == EBUSY);
    assert(unlock(second) == 0 && destroy(second) == 0);
    int (*trylock)(void *) = dlsym(library, "klb_pthread_mutex_trylock");
    int (*timedwait)(void *, void *, const struct timespec *) = dlsym(library, "klb_pthread_cond_timedwait");
    assert(trylock && timedwait);
    _Alignas(4) uint32_t static_mutex[10] = {1u << 14};
    assert(lock(static_mutex) == 0 && lock(static_mutex) == 0);
    assert(unlock(static_mutex) == 0 && unlock(static_mutex) == 0 && destroy(static_mutex) == 0);
    memset(static_mutex, 0, sizeof static_mutex);
    assert(lock(static_mutex) == 0 && trylock(static_mutex) == EBUSY);
    assert(unlock(static_mutex) == 0 && destroy(static_mutex) == 0);
    static_mutex[0] = 2u << 14;
    assert(lock(static_mutex) == 0 && lock(static_mutex) == 35); /* Linux EDEADLK. */
    assert(unlock(static_mutex) == 0 && destroy(static_mutex) == 0);
    memset(static_mutex, 0, sizeof static_mutex);
    uint32_t condition[12] = {0};
    /* Cocos2d uses a normal condition mutex without acquiring it first.
     * Bionic and Darwin normal mutexes sleep and return owning that mutex;
     * replacing it with a recursive mutex turns this into an EINVAL spin. */
    for (unsigned i = 0; i < 20; ++i) {
        struct timespec deadline, after;
        assert(clock_gettime(CLOCK_REALTIME, &deadline) == 0);
        deadline.tv_nsec += 1000000;
        if (deadline.tv_nsec >= 1000000000) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000; }
        assert(timedwait(condition, static_mutex, &deadline) == 110); /* Linux ETIMEDOUT. */
        assert(clock_gettime(CLOCK_REALTIME, &after) == 0);
        assert(after.tv_sec > deadline.tv_sec || (after.tv_sec == deadline.tv_sec && after.tv_nsec >= deadline.tv_nsec));
        assert(unlock(static_mutex) == 0);
    }
    assert(destroy(static_mutex) == 0);
    lock_guest = lock; unlock_guest = unlock;
    pthread_t threads[8];
    for (size_t i = 0; i < 8; ++i) assert(pthread_create(&threads[i], NULL, contend, NULL) == 0);
    for (size_t i = 0; i < 8; ++i) assert(pthread_join(threads[i], NULL) == 0);
    assert(shared_count == 8000);
    assert(destroy(shared_mutex) == 0);
    wait_guest = dlsym(library, "klb_pthread_cond_wait");
    int (*condition_init)(void *, const void *) = dlsym(library, "klb_pthread_cond_init");
    int (*condition_destroy)(void *) = dlsym(library, "klb_pthread_cond_destroy");
    assert(wait_guest && condition_init && condition_destroy);
    assert(condition_init(shared_condition, NULL) == 0);
    pthread_t sleeper;
    assert(pthread_create(&sleeper, NULL, sleep_until_cancelled, NULL) == 0);
    while (!atomic_load(&waiting)) sched_yield();
    assert(lock(shared_mutex) == 0); /* Wait until the cond wait released it. */
    assert(unlock(shared_mutex) == 0);
    assert(pthread_cancel(sleeper) == 0);
    void *cancel_result = NULL;
    assert(pthread_join(sleeper, &cancel_result) == 0 && cancel_result == PTHREAD_CANCELED);
    assert(destroy(shared_mutex) == 0);
    assert(condition_destroy(shared_condition) == 0);
    free(seen);
    free(storage);
    puts("PASS native mutex types, sleeping condition waits, collision deletion, cancellation and concurrent publication");
    return 0;
}

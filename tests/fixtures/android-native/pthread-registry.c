#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include "pthread-mutex-map.h"

int main(void) {
    unsigned char storage[4096] = {0};
    for (unsigned round = 0; round < 100; ++round) {
        for (unsigned i = 0; i < sizeof storage; i += 4) {
            mtx_entry *entry = mtx_entry_for(storage + i);
            assert(entry && atomic_load(&entry->users) == 1);
            assert(mtx_destroy(storage + i) == EBUSY);
            assert(pthread_mutex_lock(mtx_host(entry)) == 0);
            assert(pthread_mutex_unlock(mtx_host(entry)) == 0);
            mtx_entry_release(entry);
        }
        for (unsigned i = 0; i < sizeof storage; i += 4) assert(mtx_destroy(storage + i) == 0);
        for (unsigned i = 0; i < MTX_BUCKET_COUNT; ++i) assert(g_mtx_buckets[i].head == NULL);
    }
    puts("PASS mutex registry retires 102400 owners without retained nodes");
}

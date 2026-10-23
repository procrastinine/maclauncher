#include <assert.h>
#include <sched.h>
#include <stdio.h>
#include "audio-pause-overlay.c"

static int observed;
static void *recover(void *unused){
    (void)unused;observed=owned_recovery_begin(500000000);
    if(observed)owned_recovery_end();return NULL;
}
int main(void){
    g_open=1;g_playing=1;
    atomic_store(&g_last_render_ns,now_ns()-1000000000);
    pthread_mutex_lock(&g_wlock);
    pthread_t thread;assert(pthread_create(&thread,NULL,recover,NULL)==0);
    while(!atomic_load(&owned_recovery_pending))sched_yield();
    // A healthy callback arrives while recovery waits for the producer.
    atomic_store(&g_last_render_ns,now_ns());
    pthread_mutex_unlock(&g_wlock);assert(pthread_join(thread,NULL)==0);
    assert(observed==0&&!atomic_load(&owned_recovery_pending));
    atomic_store(&g_last_render_ns,now_ns()-1000000000);
    owned_recovery_writer=1;
    assert(owned_recovery_begin(500000000));
    assert(pthread_create(&thread,NULL,recover,NULL)==0);
    assert(pthread_join(thread,NULL)==0&&observed==0);
    owned_recovery_end();owned_recovery_writer=0;
    atomic_store(&g_last_render_ns,now_ns()+1000000000);
    assert(!owned_recovery_begin(500000000));
    puts("PASS audio recovery serializes owners and rechecks resumed heartbeat");
    g_open=0;g_playing=0;return 0;
}

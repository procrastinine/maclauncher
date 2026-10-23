#include FUTEX_SOURCE

/* Test-only access forces reader contention at the existing metadata owner. */
void fixture_futex_metadata_lock(int locked){
    if(locked)pthread_mutex_lock(&klj_futex_lock);else pthread_mutex_unlock(&klj_futex_lock);
}

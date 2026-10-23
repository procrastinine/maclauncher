#pragma once
#include <algorithm>
#include <cstdint>

namespace macfx {
// One browser/window process publishes ownership; render-only children read it.
// The file is newly zeroed for each launch. Keep the first fields stable for
// readers and append the publisher identity after the existing window record.
struct WindowState {
    uint32_t sequence,window,width,height,count,contexts[64],pointsWidth,pointsHeight,publisher;
};
struct WindowSnapshot {
    uint32_t window=0,width=0,height=0,count=0,contexts[64]={},pointsWidth=0,pointsHeight=0;
};
static_assert(sizeof(WindowState)<=4096,"Window ownership must fit its shared page");
inline bool publishWindowState(WindowState *state,const WindowSnapshot &snapshot,uint32_t process) {
    if(!state || !process) return false;
    uint32_t publisher=__atomic_load_n(&state->publisher,__ATOMIC_ACQUIRE);
    if(!publisher && snapshot.window) {
        uint32_t empty=0;
        __atomic_compare_exchange_n(&state->publisher,&empty,process,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE);
        publisher=__atomic_load_n(&state->publisher,__ATOMIC_ACQUIRE);
    }
    // A GPU/helper process has no local NSWindow. Its timer must neither erase
    // ownership nor interleave another writer with the publication sequence.
    if(publisher!=process) return false;
    __atomic_fetch_add(&state->sequence,1,__ATOMIC_ACQ_REL);
    __atomic_store_n(&state->window,snapshot.window,__ATOMIC_RELAXED);
    __atomic_store_n(&state->width,snapshot.width,__ATOMIC_RELAXED);
    __atomic_store_n(&state->height,snapshot.height,__ATOMIC_RELAXED);
    __atomic_store_n(&state->pointsWidth,snapshot.pointsWidth,__ATOMIC_RELAXED);
    __atomic_store_n(&state->pointsHeight,snapshot.pointsHeight,__ATOMIC_RELAXED);
    const unsigned count=std::min(snapshot.count,64u);
    __atomic_store_n(&state->count,count,__ATOMIC_RELAXED);
    for(unsigned i=0;i<count;++i) __atomic_store_n(&state->contexts[i],snapshot.contexts[i],__ATOMIC_RELAXED);
    __atomic_fetch_add(&state->sequence,1,__ATOMIC_RELEASE);
    return true;
}
}

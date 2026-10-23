#include <android/trace.h>
#include <cutils/trace.h>
#include <cassert>
#include <climits>
#include <cstdio>
#include <cstring>
#include <thread>

static int retained;
static void* previous(const char* name){return !strcmp(name,"retained")?&retained:nullptr;}
#include "native-import-registry.h"
bool kljInstallTraceImports();

static void exercise(){
    auto enabled=reinterpret_cast<bool(*)()>(klj_resolve_import("ATrace_isEnabled"));
    auto begin=reinterpret_cast<void(*)(const char*)>(klj_resolve_import("ATrace_beginSection"));
    auto end=reinterpret_cast<void(*)()>(klj_resolve_import("ATrace_endSection"));
    auto asyncBegin=reinterpret_cast<void(*)(const char*,int32_t)>(klj_resolve_import("ATrace_beginAsyncSection"));
    auto asyncEnd=reinterpret_cast<void(*)(const char*,int32_t)>(klj_resolve_import("ATrace_endAsyncSection"));
    auto counter=reinterpret_cast<void(*)(const char*,int64_t)>(klj_resolve_import("ATrace_setCounter"));
    assert(enabled&&begin&&end&&asyncBegin&&asyncEnd&&counter);
    for(int i=0;i<10000;i++){
        assert(!enabled());begin("outer");begin("inner");end();end();
        asyncBegin("asynchronous",INT32_MIN);counter("wide",INT64_MAX);asyncEnd("asynchronous",INT32_MIN);
    }
}
int main(){
    assert(klj_register_import_resolver(previous));assert(kljInstallTraceImports());assert(kljInstallTraceImports());assert(klj_resolve_import("retained")==&retained);
    assert(!klj_resolve_import("unrelated-missing"));
    assert(atrace_marker_fd==-1&&atrace_enabled_tags==0);
    exercise();std::thread first(exercise),second(exercise);first.join();second.join();
    assert(atrace_marker_fd==-1&&atrace_enabled_tags==0);
    puts("PASS original ATrace complete namespace, sync/async/counter calls, idempotent registry and shared no-collector state");
}

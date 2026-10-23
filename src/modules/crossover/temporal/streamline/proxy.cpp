#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <array>
#include <cstddef>
#include <sl_core_api.h>
#include "camera.hpp"
#include "exports.hpp"

static_assert(offsetof(sl::Constants, motionVectorsJittered) == 450, "Streamline Constants ABI changed");
static_assert(sizeof(sl::BaseStructure) == 32, "Streamline BaseStructure ABI changed");
extern "C" { void *maclauncherTargets[maclauncherExportCount] = {}; }
namespace {
HMODULE selfModule;
INIT_ONCE initialized = INIT_ONCE_STATIC_INIT;
HMODULE originalModule;
BOOL CALLBACK initialize(PINIT_ONCE, void *, void **) {
    wchar_t file[32768];const DWORD count = GetModuleFileNameW(selfModule, file, 32768);
    if (!count || count >= 32768) return FALSE;
    wchar_t *name = wcsrchr(file, L'\\');if (!name) return FALSE;
    wcscpy_s(name + 1, 32768 - (name + 1 - file), L"maclauncher_streamline_original.dll");
    originalModule = LoadLibraryExW(file, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    return originalModule != nullptr;
}
template<class T> T original(const char *name) {
    InitOnceExecuteOnce(&initialized, initialize, nullptr, nullptr);
    return originalModule ? reinterpret_cast<T>(GetProcAddress(originalModule, name)) : nullptr;
}
struct Entry { uint64_t age = 0; uint32_t frame = 0, viewport = 0; bool valid = false; RSTemporalCamera value{}; };
std::array<Entry, 128> entries;
SRWLOCK cacheLock = SRWLOCK_INIT;
uint64_t age = 0;
void remember(uint32_t frame, uint32_t viewport, const RSTemporalCamera *value) {
    AcquireSRWLockExclusive(&cacheLock);
    Entry *target = &entries[0];
    for (auto &entry : entries) {
        if (entry.age && entry.frame == frame && entry.viewport == viewport) { target = &entry;break; }
        if (entry.age < target->age) target = &entry;
    }
    *target = { ++age, frame, viewport, value != nullptr, value ? *value : RSTemporalCamera{} };
    ReleaseSRWLockExclusive(&cacheLock);
}
bool lookup(uint32_t frame, uint32_t viewport, RSTemporalCamera &value) {
    bool found = false;AcquireSRWLockShared(&cacheLock);
    for (const auto &entry : entries) if (entry.age && entry.frame == frame && entry.viewport == viewport) {
        found = entry.valid;if (found) value = entry.value;break;
    }
    ReleaseSRWLockShared(&cacheLock);return found;
}
bool viewport(const sl::BaseStructure **inputs, uint32_t count, uint32_t &id) {
    if (!inputs || count > 256) return false;
    bool found = false;
    for (uint32_t i = 0; i < count; ++i) {
        auto item = inputs[i];unsigned links = 0;
        while (item && links++ < 32) {
            if (item->structType == sl::ViewportHandle::s_structType) {
                if (item->structVersion != 1) return false;
                const auto next = uint32_t(*static_cast<const sl::ViewportHandle *>(item));
                if (found && next != id) return false;
                found = true;id = next;
            }
            item = item->next;
        }
        if (item) return false;
    }
    return found;
}
using SetCamera = int (__cdecl *)(const RSTemporalCamera *);
using ClearCamera = void (__cdecl *)();
thread_local const RSTemporalCamera *activeCamera = nullptr;
struct CameraScope {
    RSTemporalCamera value{};
    const RSTemporalCamera *previous;
    SetCamera set = nullptr;ClearCamera clear = nullptr;
    explicit CameraScope(const RSTemporalCamera *next) : previous(activeCamera) {
        auto ngx = GetModuleHandleW(L"nvngx.dll");
        if (ngx) { set = reinterpret_cast<SetCamera>(GetProcAddress(ngx, "MacLauncherSetTemporalCamera"));clear = reinterpret_cast<ClearCamera>(GetProcAddress(ngx, "MacLauncherClearTemporalCamera")); }
        if (!set || !clear) return;
        clear();activeCamera = nullptr;
        if (next) { value = *next;if (set(&value)) activeCamera = &value; }
    }
    ~CameraScope() {
        if (!set || !clear) return;
        clear();activeCamera = previous;if (previous) set(previous);
    }
};
}
extern "C" void *maclauncherResolveExport(uint32_t index) {
    if (index < maclauncherExportCount) if (auto address = original<void *>(maclauncherExportNames[index])) {
        InterlockedExchangePointer(&maclauncherTargets[index], address);return address;
    }
    RaiseException(EXCEPTION_ILLEGAL_INSTRUCTION, EXCEPTION_NONCONTINUABLE, 0, nullptr);
    return nullptr;
}
extern "C" BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) selfModule = module;
    return TRUE;
}
extern "C" sl::Result slSetConstants(const sl::Constants &values, const sl::FrameToken &frame, const sl::ViewportHandle &view) {
    const auto fn = original<PFun_slSetConstants *>("slSetConstants");if (!fn) return sl::Result::eErrorMissingOrInvalidAPI;
    const auto frameId = uint32_t(frame), viewId = uint32_t(view);
    RSTemporalCamera camera{};const bool valid = maclauncher_streamline::camera(values, frameId, viewId, camera);
    const auto result = fn(values, frame, view);
    remember(frameId, viewId, valid && result == sl::Result::eOk ? &camera : nullptr);
    return result;
}
extern "C" sl::Result slEvaluateFeature(sl::Feature feature, const sl::FrameToken &frame, const sl::BaseStructure **inputs, uint32_t count, sl::CommandBuffer *commands) {
    const auto fn = original<PFun_slEvaluateFeature *>("slEvaluateFeature");if (!fn) return sl::Result::eErrorMissingOrInvalidAPI;
    if (feature != sl::kFeatureDLSS) return fn(feature, frame, inputs, count, commands);
    uint32_t viewId = 0;RSTemporalCamera camera{};
    const bool valid = viewport(inputs, count, viewId) && lookup(uint32_t(frame), viewId, camera);
    CameraScope scope(valid ? &camera : nullptr);
    return fn(feature, frame, inputs, count, commands);
}
extern "C" sl::Result slShutdown() {
    const auto fn = original<PFun_slShutdown *>("slShutdown");if (!fn) return sl::Result::eErrorMissingOrInvalidAPI;
    const auto result = fn();AcquireSRWLockExclusive(&cacheLock);entries = {};age = 0;ReleaseSRWLockExclusive(&cacheLock);
    return result;
}

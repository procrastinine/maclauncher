#include <gdextension_interface.h>
#include "../../shared/reshade/temporal/camera.h"
#include "../../shared/reshade/temporal/frame.h"
#include "../../shared/reshade/temporal/scene.h"
#include "../../shared/reshade/temporal/scene-matrices.h"
#include "../../shared/reshade/temporal/scene-destination.h"
#include "../../shared/reshade/temporal/scene-aovs.h"
#include "../../shared/reshade/temporal/scene-copy-boundary.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <atomic>
#include <memory>
#include <mutex>

namespace {
using SetCamera = int (*)(void *, void *, void *, void *, const RSTemporalCamera *);
using ClearCamera = void (*)(void *);
using ReadMethod = uint32_t (*)();
using ReadDemand = uint32_t (*)(uint32_t);
using SetMatrices = int (*)(void*,void*,void*,void*,const RSSceneMatrices*);
using SetDestination = decltype(&rsSetTemporalSceneDestinationForTextures);
SetCamera setCamera;
ClearCamera clearCamera;
ReadMethod readMethod;
ReadDemand readDemand;
SetMatrices setMatrices;
SetDestination setDestination;
decltype(&rsSetTemporalSceneDestinationFlagsForTextures) setDestinationFlags;
decltype(&rsClearTemporalSceneDestinationTextures) clearDestination;
decltype(&rsSetTemporalAovsForTexturesObserved) setAovs;
decltype(&rsClearTemporalAovsTextures) clearAovs;
decltype(&rsGetSceneAovDemand) readAovDemand;
decltype(&rsSetTemporalSceneCopyBoundary) setSceneCopy;
decltype(&rsClearTemporalSceneCopyBoundaries) clearSceneCopies;
decltype(&rsSceneCopyBoundaryAPI) sceneCopyAPI;
bool needsScene(){return readDemand?readDemand(1)!=0:readMethod&&readMethod()!=0;}
GDExtensionClassLibraryPtr library;
GDExtensionInterfaceStringNameNewWithUtf8Chars nameNew;
GDExtensionInterfaceStringNewWithUtf8Chars stringNew;
GDExtensionInterfaceVariantGetPtrDestructor destructor;
GDExtensionInterfaceGetVariantToTypeConstructor toType;
GDExtensionInterfaceGetVariantFromTypeConstructor fromType;
GDExtensionInterfaceVariantGetType variantType;
GDExtensionInterfaceVariantNewNil newNil;
GDExtensionInterfaceClassdbConstructObject construct;
GDExtensionInterfaceObjectSetInstance setInstance;
GDExtensionInterfaceClassdbRegisterExtensionClass2 registerClass;
GDExtensionInterfaceClassdbRegisterExtensionClassMethod registerMethod;
GDExtensionInterfaceClassdbUnregisterExtensionClass unregisterClass;
constexpr char className[] = "MacLauncherTemporalCameraBridge";
// Godot owns the opaque value layouts. Generous aligned storage is passed only
// to its constructors/destructors; no engine memory or C++ object is inspected.
struct Name {
    alignas(16) unsigned char value[64]{};
    explicit Name(const char *text) { nameNew(value, text); }
    ~Name() { destructor(GDEXTENSION_VARIANT_TYPE_STRING_NAME)(value); }
};
struct String {
    alignas(16) unsigned char value[64]{};
    explicit String(const char *text) { stringNew(value, text); }
    ~String() { destructor(GDEXTENSION_VARIANT_TYPE_STRING)(value); }
};
struct AovPool {
    struct Slot {unsigned users=0;bool reserved=false;uint64_t frameId=0,viewId=0;};
    std::mutex mutex;std::array<Slot,3>slots{};
};
std::atomic<uint64_t> nextEpoch{1};
struct Bridge {
    uint64_t submitted = 0;
    const uint64_t epoch=nextEpoch.fetch_add(1);
    std::shared_ptr<AovPool> aovPool=std::make_shared<AovPool>();
    std::mutex aovMutex;
    bool aovAccepting=true;
    RSSceneMatrices sceneMatrices{};
    RSTemporalCamera sceneCamera{};
    std::array<uintptr_t,3>matrixTextures{},cameraTextures{};
    std::atomic<uintptr_t> nativeWindow{0};
    ~Bridge() { if (clearCamera) clearCamera(this); if(clearDestination)clearDestination(this);if(clearAovs)clearAovs(this);if(clearSceneCopies)clearSceneCopies(this); }
};
GDExtensionObjectPtr create(void *) {
    Name base("RefCounted"), name(className);
    auto object = construct(base.value);
    if (object) setInstance(object, name.value, new Bridge);
    return object;
}
void freeInstance(void *, GDExtensionClassInstancePtr instance) { delete static_cast<Bridge *>(instance); }
enum Operation { Available, Method, Clear, Submit, NeedsScene, Matrices, Destination, Window, AovDemand, AovAcquire, AovRelease, Aovs, AovRetire, AovIdle, AovResume, SceneCopy, ClearSceneCopy, StageCamera, StageMatrices, SceneCopyAvailable, AovSlotIdle };
constexpr std::array<GDExtensionVariantType, 9> argumentTypes = {
    GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT,
    GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_FLOAT,
    GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT
};
bool submit(Bridge *owner, const int64_t *integers, const double *numbers,bool publish=true) {
    if (!owner||(publish&&(!setCamera||!clearCamera))) return false;
    RSTemporalCamera camera{};
    camera.size = sizeof(camera); camera.version = 1;
    camera.flags = RS_TEMPORAL_DEPTH_REVERSED | RS_TEMPORAL_HDR;
    camera.frameId = uint64_t(integers[7]); camera.viewportId = uint64_t(integers[8]);
    camera.nearPlane = float(numbers[3]); camera.farPlane = float(numbers[4]);
    camera.verticalFov = float(numbers[5]); camera.frameTimeMs = float(numbers[6]);
    {std::lock_guard<std::mutex>guard(owner->aovMutex);owner->sceneCamera=camera;owner->cameraTextures={uintptr_t(integers[0]),uintptr_t(integers[1]),uintptr_t(integers[2])};}
    if(!publish)return true;
    const auto status = setCamera(owner, reinterpret_cast<void *>(uintptr_t(integers[0])),
        reinterpret_cast<void *>(uintptr_t(integers[1])), reinterpret_cast<void *>(uintptr_t(integers[2])), &camera);
    if (status == RS_TEMPORAL_OK && owner->submitted++ == 0 && std::getenv("MACLAUNCHER_GODOT_GRAPHICS_TRACE"))
        std::fprintf(stderr, "[Godot graphics] Camera registered near=%g far=%g verticalFov=%g viewport=%llu\n",
            camera.nearPlane, camera.farPlane, camera.verticalFov, (unsigned long long)camera.viewportId);
    return status == RS_TEMPORAL_OK;
}
bool submitMatrices(Bridge*owner,const std::array<int64_t,4>&identities,const std::array<double,32>&values,bool publish=true){
    if(!owner||(publish&&!setMatrices))return false;RSSceneMatrices matrices{};matrices.size=sizeof(matrices);matrices.version=1;matrices.frameId=uint64_t(identities[3]);matrices.flags=RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID|RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_PROJECTION_JITTERED;
    // RenderSceneDataRD returns its actual depth-corrected, jittered projection.
    // Camera3D's positive vertical projection becomes negative after RD's Y
    // correction. Retain that declared orientation in the shared scene tuple.
    if(values[21]<0)matrices.flags|=RS_SCENE_PROJECTION_Y_DOWN;
    // GDScript supplies column-vector rows; the shared ABI uses row vectors.
    for(unsigned row=0;row<4;++row)for(unsigned column=0;column<4;++column){matrices.view[row*4+column]=float(values[column*4+row]);matrices.projection[row*4+column]=float(values[16+column*4+row]);}
    {std::lock_guard<std::mutex>guard(owner->aovMutex);owner->sceneMatrices=matrices;owner->matrixTextures={uintptr_t(identities[0]),uintptr_t(identities[1]),uintptr_t(identities[2])};}
    if(!publish)return true;
    return setMatrices(owner,reinterpret_cast<void*>(uintptr_t(identities[0])),reinterpret_cast<void*>(uintptr_t(identities[1])),reinterpret_cast<void*>(uintptr_t(identities[2])),&matrices)==RS_TEMPORAL_OK;
}
bool submitDestination(Bridge*owner,const std::array<int64_t,4>&values){
    const auto window=owner?owner->nativeWindow.load(std::memory_order_acquire):0;
    if(!owner||!window||values[3]<=0)return false;
    auto color=reinterpret_cast<void*>(uintptr_t(values[0])),depth=reinterpret_cast<void*>(uintptr_t(values[1])),motion=reinterpret_cast<void*>(uintptr_t(values[2]));
    if(setDestinationFlags)return setDestinationFlags(owner,reinterpret_cast<void*>(window),color,depth,motion,uint64_t(values[3]),RS_TEMPORAL_HDR)==RS_TEMPORAL_OK;
    return setDestination&&setDestination(owner,reinterpret_cast<void*>(window),color,depth,motion,uint64_t(values[3]))==RS_TEMPORAL_OK;
}
struct AovLease {std::shared_ptr<AovPool> pool;unsigned slot;};
int64_t aovAcquire(Bridge*owner){
    if(!owner||!setAovs||!clearAovs||!readAovDemand||!readAovDemand(1))return 0;
    std::lock_guard<std::mutex>guard(owner->aovMutex);if(!owner->aovAccepting)return 0;
    std::lock_guard<std::mutex>pool(owner->aovPool->mutex);
    for(unsigned i=0;i<owner->aovPool->slots.size();++i){auto&slot=owner->aovPool->slots[i];if(!slot.users){slot={1,true,0,0};return i+1;}}
    return 0;
}
bool aovRelease(Bridge*owner,int64_t index){if(!owner||index<1||index>3)return false;std::lock_guard<std::mutex>guard(owner->aovPool->mutex);auto&slot=owner->aovPool->slots[index-1];if(!slot.reserved)return false;slot.reserved=false;--slot.users;return true;}
bool aovIdle(Bridge*owner){if(!owner)return true;std::lock_guard<std::mutex>guard(owner->aovPool->mutex);for(auto&slot:owner->aovPool->slots)if(slot.users)return false;return true;}
bool aovSlotIdle(Bridge*owner,int64_t index){if(!owner||index<1||index>3)return false;std::lock_guard<std::mutex>guard(owner->aovPool->mutex);return owner->aovPool->slots[index-1].users==0;}
bool retireAovs(Bridge*owner){if(!owner)return false;std::lock_guard<std::mutex>guard(owner->aovMutex);owner->aovAccepting=false;if(clearAovs)clearAovs(owner);if(clearSceneCopies)clearSceneCopies(owner);std::lock_guard<std::mutex>pool(owner->aovPool->mutex);for(auto&slot:owner->aovPool->slots)if(slot.reserved){slot.reserved=false;--slot.users;}return true;}
bool resumeAovs(Bridge*owner){if(!owner)return false;std::lock_guard<std::mutex>guard(owner->aovMutex);if(!aovIdle(owner))return false;owner->aovAccepting=true;return true;}
bool submitAovs(Bridge*owner,const std::array<int64_t,13>&v,double exposure,bool copy=false,double frameTimeMs=0){
    if(!owner||(!copy&&!setAovs)||!clearAovs||v[6]<=0||v[7]<=0||v[8]<1||v[8]>3||v[9]<1||v[9]>16384||v[10]<1||v[10]>16384||!std::isfinite(exposure)||exposure<=0)return false;
    constexpr uint64_t allowedFlags=RS_SCENE_AOV_RADIANCE_INCLUDES_SPECULAR|RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR|RS_SCENE_AOV_SPECULAR_MERGE_PENDING;
    const auto flags=uint64_t(v[12]);if(flags&~allowedFlags||((flags&RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR)&&(flags&RS_SCENE_AOV_SPECULAR_MERGE_PENDING)))return false;
    if((flags&RS_SCENE_AOV_SPECULAR_MERGE_PENDING)&&(!copy||!v[4]))return false;
    std::lock_guard<std::mutex>guard(owner->aovMutex);if(!owner->aovAccepting)return false;
    RSTemporalFrame scene{};
    if(copy){
        if(!setSceneCopy||!sceneCopyAPI||sceneCopyAPI()!=1||!owner->nativeWindow.load(std::memory_order_acquire)||!v[0]||!v[1]||!v[2]||!v[5]||!std::isfinite(frameTimeMs)||frameTimeMs<0||frameTimeMs>1000||owner->sceneMatrices.frameId!=uint64_t(v[6])||owner->matrixTextures!=std::array<uintptr_t,3>{uintptr_t(v[0]),uintptr_t(v[1]),uintptr_t(v[2])})return false;
        scene.size=sizeof(scene);scene.version=1;scene.owner=owner;scene.frameId=uint64_t(v[6]);scene.method=RS_TEMPORAL_OFF;scene.flags=RS_TEMPORAL_HDR|RS_TEMPORAL_DEPTH_REVERSED;
        scene.color=reinterpret_cast<void*>(uintptr_t(v[5]));scene.output=reinterpret_cast<void*>(uintptr_t(v[0]));scene.depth=reinterpret_cast<void*>(uintptr_t(v[1]));scene.motion=reinterpret_cast<void*>(uintptr_t(v[2]));
        scene.renderWidth=scene.outputWidth=scene.maxRenderWidth=uint32_t(v[9]);scene.renderHeight=scene.outputHeight=scene.maxRenderHeight=uint32_t(v[10]);scene.motionScaleX=float(v[9]);scene.motionScaleY=float(v[10]);scene.preExposure=float(exposure);scene.frameTimeMs=float(frameTimeMs);
        if(owner->sceneCamera.frameId==scene.frameId&&owner->cameraTextures==owner->matrixTextures){scene.flags|=RS_TEMPORAL_CAMERA_VALID;scene.nearPlane=owner->sceneCamera.nearPlane;scene.farPlane=owner->sceneCamera.farPlane;scene.verticalFov=owner->sceneCamera.verticalFov;}
    }
    const auto slot=unsigned(v[8]-1);{
        std::lock_guard<std::mutex>guard(owner->aovPool->mutex);auto&state=owner->aovPool->slots[slot];
        if(!state.reserved||!state.users||(state.frameId&&(state.frameId!=uint64_t(v[6])||state.viewId!=uint64_t(v[7]))))return false;
        state.frameId=uint64_t(v[6]);state.viewId=uint64_t(v[7]);++state.users;
    }
    RSSceneAovs packet{};packet.size=sizeof(packet);packet.version=1;packet.frameId=uint64_t(v[6]);packet.viewId=uint64_t(v[7]);packet.epoch=owner->epoch;
    packet.pass=RS_SCENE_AOV_AFTER_SKY;packet.colorPass=copy?RS_SCENE_AOV_AFTER_SKY:RS_SCENE_AOV_AFTER_TRANSPARENT;packet.preExposure=float(exposure);packet.flags=uint32_t(v[12]);
    // These textures contain Godot's stored linear scene signal. Camera light
    // normalization is already part of the renderer; it is not undone here.
    packet.color={sizeof(RSImageColorDescription),1,RS_COLOR_BT709,RS_COLOR_LINEAR,RS_COLOR_FULL,RS_COLOR_OPAQUE,203,1000,0,1.2f,RS_COLOR_SCENE_REFERRED,0};
    const auto requested=uint32_t(v[11]);
    auto image=[&](unsigned target,int64_t pointer,unsigned encoding,unsigned channel,unsigned space,float scale=1.f){if(pointer&&(requested&(1u<<target)))packet.images[target]={reinterpret_cast<void*>(uintptr_t(pointer)),0,0,uint32_t(v[9]),uint32_t(v[10]),encoding,space,channel,RS_SCENE_AOV_TOP_LEFT,scale,0,RS_SCENE_AOV_AFTER_SKY,0};};
    image(RS_SCENE_AOV_NORMAL,v[3],RS_SCENE_AOV_XYZ_UNORM,0,RS_SCENE_AOV_SPACE_VIEW);
    image(RS_SCENE_AOV_ROUGHNESS,v[3],RS_SCENE_AOV_ROUGHNESS_FOLDED,3,RS_SCENE_AOV_SPACE_NONE,255.f/127.f);
    image(RS_SCENE_AOV_RESOLVED_SPECULAR,v[4],RS_SCENE_AOV_LINEAR,0,RS_SCENE_AOV_SPACE_NONE);
    image(RS_SCENE_AOV_METALLIC,v[4],RS_SCENE_AOV_SCALAR,3,RS_SCENE_AOV_SPACE_NONE);
    image(RS_SCENE_AOV_RESOLVED_RADIANCE,v[5],RS_SCENE_AOV_LINEAR,0,RS_SCENE_AOV_SPACE_NONE);
    // Lit specular and radiance never become material reflectance or noisy rays.
    auto lease=std::make_unique<AovLease>(AovLease{owner->aovPool,slot});
    RSSceneAovRetirement retirement{sizeof(RSSceneAovRetirement),1,lease.get(),[](void*context,uint64_t,uint64_t,uint64_t){std::unique_ptr<AovLease>done(static_cast<AovLease*>(context));std::lock_guard<std::mutex>guard(done->pool->mutex);--done->pool->slots[done->slot].users;}};
    const auto result=copy?setSceneCopy(owner,reinterpret_cast<void*>(owner->nativeWindow.load(std::memory_order_acquire)),&scene,&owner->sceneMatrices,&packet,&retirement):setAovs(owner,reinterpret_cast<void*>(uintptr_t(v[0])),reinterpret_cast<void*>(uintptr_t(v[1])),reinterpret_cast<void*>(uintptr_t(v[2])),&packet,&retirement);
    if(result==RS_TEMPORAL_OK){lease.release();return true;}
    {std::lock_guard<std::mutex>guard(owner->aovPool->mutex);--owner->aovPool->slots[slot].users;}return false;
}
unsigned argumentCount(Operation op){return op==Submit||op==StageCamera?argumentTypes.size():op==Matrices||op==StageMatrices?36:op==Destination?4:op==Window||op==AovRelease||op==AovSlotIdle?1:op==Aovs?14:op==SceneCopy?15:0;}
GDExtensionVariantType argumentType(Operation op,unsigned i){return op==Destination||op==Window||op==AovRelease||op==AovSlotIdle?GDEXTENSION_VARIANT_TYPE_INT:op==Aovs||op==SceneCopy?(i<13?GDEXTENSION_VARIANT_TYPE_INT:GDEXTENSION_VARIANT_TYPE_FLOAT):op==Matrices||op==StageMatrices?(i<4?GDEXTENSION_VARIANT_TYPE_INT:GDEXTENSION_VARIANT_TYPE_FLOAT):argumentTypes[i];}
void call(void *operation, GDExtensionClassInstancePtr instance, const GDExtensionConstVariantPtr *args,
          GDExtensionInt count, GDExtensionVariantPtr output, GDExtensionCallError *error) {
    const auto op = Operation(uintptr_t(operation));
    const int expected = int(argumentCount(op));
    error->error = GDEXTENSION_CALL_OK;
    if (count != expected) { newNil(output); error->error = count < expected ? GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS : GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS; error->expected = expected; return; }
    if (op == Method) { int64_t value = readMethod ? readMethod() : 0; fromType(GDEXTENSION_VARIANT_TYPE_INT)(output, &value); return; }
    if (op == NeedsScene) { GDExtensionBool value=needsScene();fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return; }
    auto owner = static_cast<Bridge *>(instance);
    if(op==AovSlotIdle){if(variantType(args[0])!=GDEXTENSION_VARIANT_TYPE_INT){newNil(output);error->error=GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;error->argument=0;error->expected=GDEXTENSION_VARIANT_TYPE_INT;return;}int64_t index=0;toType(GDEXTENSION_VARIANT_TYPE_INT)(&index,const_cast<void*>(args[0]));GDExtensionBool value=aovSlotIdle(owner,index);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if(op==SceneCopyAvailable){GDExtensionBool value=setSceneCopy&&clearSceneCopies&&sceneCopyAPI&&sceneCopyAPI()==1&&owner->nativeWindow.load(std::memory_order_acquire);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if(op==ClearSceneCopy){if(clearSceneCopies)clearSceneCopies(owner);GDExtensionBool value=true;fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if(op==AovRetire||op==AovIdle||op==AovResume){GDExtensionBool value=op==AovRetire?retireAovs(owner):op==AovResume?resumeAovs(owner):aovIdle(owner);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if(op==AovDemand||op==AovAcquire){int64_t value=op==AovDemand?(readAovDemand?readAovDemand(1):0):aovAcquire(owner);fromType(GDEXTENSION_VARIANT_TYPE_INT)(output,&value);return;}
    if(op==AovRelease||op==Aovs||op==SceneCopy){std::array<int64_t,13>values{};std::array<double,2>numbers{1,0};for(unsigned i=0;i<unsigned(expected);++i){const auto type=argumentType(op,i),actual=variantType(args[i]);if(actual!=type&&!(type==GDEXTENSION_VARIANT_TYPE_FLOAT&&actual==GDEXTENSION_VARIANT_TYPE_INT)){newNil(output);error->error=GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;error->argument=i;error->expected=type;return;}if(i<13)toType(type)(&values[i],const_cast<void*>(args[i]));else toType(type)(&numbers[i-13],const_cast<void*>(args[i]));}GDExtensionBool value=op==AovRelease?aovRelease(owner,values[0]):submitAovs(owner,values,numbers[0],op==SceneCopy,numbers[1]);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if(op==Window){if(variantType(args[0])!=GDEXTENSION_VARIANT_TYPE_INT){newNil(output);error->error=GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;error->argument=0;error->expected=GDEXTENSION_VARIANT_TYPE_INT;return;}int64_t value=0;toType(GDEXTENSION_VARIANT_TYPE_INT)(&value,const_cast<void*>(args[0]));owner->nativeWindow.store(uintptr_t(value),std::memory_order_release);GDExtensionBool result=true;fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&result);return;}
    if(op==Destination){std::array<int64_t,4>values{};for(unsigned i=0;i<values.size();++i){if(variantType(args[i])!=GDEXTENSION_VARIANT_TYPE_INT){newNil(output);error->error=GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;error->argument=i;error->expected=GDEXTENSION_VARIANT_TYPE_INT;return;}toType(GDEXTENSION_VARIANT_TYPE_INT)(&values[i],const_cast<void*>(args[i]));}GDExtensionBool result=submitDestination(owner,values);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&result);return;}
    if(op==Matrices||op==StageMatrices){std::array<int64_t,4>identities{};std::array<double,32>values{};for(unsigned i=0;i<36;++i){const auto type=i<4?GDEXTENSION_VARIANT_TYPE_INT:GDEXTENSION_VARIANT_TYPE_FLOAT;const auto actual=variantType(args[i]);if(actual!=type&&!(type==GDEXTENSION_VARIANT_TYPE_FLOAT&&actual==GDEXTENSION_VARIANT_TYPE_INT)){newNil(output);error->error=GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;error->argument=i;error->expected=type;return;}if(i<4)toType(type)(&identities[i],const_cast<void*>(args[i]));else toType(type)(&values[i-4],const_cast<void*>(args[i]));}GDExtensionBool value=submitMatrices(owner,identities,values,op==Matrices);fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output,&value);return;}
    if (op == Clear) { if (clearCamera) clearCamera(owner);if(clearDestination)clearDestination(owner);if(clearAovs)clearAovs(owner);if(clearSceneCopies)clearSceneCopies(owner); newNil(output); return; }
    GDExtensionBool result = setCamera && clearCamera && readMethod;
    if (op == Submit||op==StageCamera) {
        std::array<int64_t, 9> integers{}; std::array<double, 9> numbers{};
        for (unsigned i = 0; i < argumentTypes.size(); ++i) {
            const auto actual = variantType(args[i]);
            if (actual != argumentTypes[i] && !(argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_FLOAT && actual == GDEXTENSION_VARIANT_TYPE_INT)) {
                newNil(output); error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT; error->argument = i; error->expected = argumentTypes[i]; return;
            }
            if (argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_INT) toType(argumentTypes[i])(&integers[i], const_cast<void *>(args[i]));
            else toType(argumentTypes[i])(&numbers[i], const_cast<void *>(args[i]));
        }
        result = submit(owner, integers.data(), numbers.data(),op==Submit);
    }
    fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output, &result);
}
void ptrcall(void *operation, GDExtensionClassInstancePtr instance, const GDExtensionConstTypePtr *args, GDExtensionTypePtr output) {
    const auto op = Operation(uintptr_t(operation)); auto owner = static_cast<Bridge *>(instance);
    if(op==AovSlotIdle){*static_cast<GDExtensionBool*>(output)=aovSlotIdle(owner,*static_cast<const int64_t*>(args[0]));return;}
    if(op==SceneCopyAvailable){*static_cast<GDExtensionBool*>(output)=setSceneCopy&&clearSceneCopies&&sceneCopyAPI&&sceneCopyAPI()==1&&owner->nativeWindow.load(std::memory_order_acquire);return;}
    if(op==ClearSceneCopy){if(clearSceneCopies)clearSceneCopies(owner);*static_cast<GDExtensionBool*>(output)=true;return;}
    if (op == Method) { *static_cast<int64_t *>(output) = readMethod ? readMethod() : 0; return; }
    if (op == NeedsScene) { *static_cast<GDExtensionBool *>(output)=needsScene();return; }
    if(op==AovRetire||op==AovIdle||op==AovResume){*static_cast<GDExtensionBool*>(output)=op==AovRetire?retireAovs(owner):op==AovResume?resumeAovs(owner):aovIdle(owner);return;}
    if(op==AovDemand||op==AovAcquire){*static_cast<int64_t*>(output)=op==AovDemand?(readAovDemand?readAovDemand(1):0):aovAcquire(owner);return;}
    if(op==AovRelease||op==Aovs||op==SceneCopy){std::array<int64_t,13>values{};std::array<double,2>numbers{1,0};for(unsigned i=0;i<argumentCount(op);++i)if(i<13)values[i]=*static_cast<const int64_t*>(args[i]);else numbers[i-13]=*static_cast<const double*>(args[i]);*static_cast<GDExtensionBool*>(output)=op==AovRelease?aovRelease(owner,values[0]):submitAovs(owner,values,numbers[0],op==SceneCopy,numbers[1]);return;}
    if(op==Window){owner->nativeWindow.store(uintptr_t(*static_cast<const int64_t*>(args[0])),std::memory_order_release);*static_cast<GDExtensionBool*>(output)=true;return;}
    if(op==Destination){std::array<int64_t,4>values{};for(unsigned i=0;i<values.size();++i)values[i]=*static_cast<const int64_t*>(args[i]);*static_cast<GDExtensionBool*>(output)=submitDestination(owner,values);return;}
    if(op==Matrices||op==StageMatrices){std::array<int64_t,4>identities{};std::array<double,32>values{};for(unsigned i=0;i<36;++i)if(i<4)identities[i]=*static_cast<const int64_t*>(args[i]);else values[i-4]=*static_cast<const double*>(args[i]);*static_cast<GDExtensionBool*>(output)=submitMatrices(owner,identities,values,op==Matrices);return;}
    if (op == Clear) { if (clearCamera) clearCamera(owner);if(clearDestination)clearDestination(owner);if(clearAovs)clearAovs(owner);if(clearSceneCopies)clearSceneCopies(owner); return; }
    bool result = setCamera && clearCamera && readMethod;
    if (op == Submit||op==StageCamera) {
        std::array<int64_t, 9> integers{}; std::array<double, 9> numbers{};
        for (unsigned i = 0; i < argumentTypes.size(); ++i)
            if (argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_INT) integers[i] = *static_cast<const int64_t *>(args[i]);
            else numbers[i] = *static_cast<const double *>(args[i]);
        result = submit(owner, integers.data(), numbers.data(),op==Submit);
    }
    *static_cast<GDExtensionBool *>(output) = result;
}
void initialize(void *, GDExtensionInitializationLevel level) {
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;
    setCamera = reinterpret_cast<SetCamera>(dlsym(RTLD_DEFAULT, "rsSetTemporalCameraForTextures"));
    clearCamera = reinterpret_cast<ClearCamera>(dlsym(RTLD_DEFAULT, "rsClearTemporalCameraTextures"));
    readMethod = reinterpret_cast<ReadMethod>(dlsym(RTLD_DEFAULT, "rsGetTemporalMethod"));
    readDemand = reinterpret_cast<ReadDemand>(dlsym(RTLD_DEFAULT, "rsGetSceneFrameDemand"));
    setMatrices = reinterpret_cast<SetMatrices>(dlsym(RTLD_DEFAULT,"rsSetTemporalMatricesForTextures"));
    setDestination = reinterpret_cast<SetDestination>(dlsym(RTLD_DEFAULT,"rsSetTemporalSceneDestinationForTextures"));
    setDestinationFlags = reinterpret_cast<decltype(setDestinationFlags)>(dlsym(RTLD_DEFAULT,"rsSetTemporalSceneDestinationFlagsForTextures"));
    clearDestination = reinterpret_cast<ClearCamera>(dlsym(RTLD_DEFAULT,"rsClearTemporalSceneDestinationTextures"));
    setAovs=reinterpret_cast<decltype(setAovs)>(dlsym(RTLD_DEFAULT,"rsSetTemporalAovsForTexturesObserved"));
    clearAovs=reinterpret_cast<decltype(clearAovs)>(dlsym(RTLD_DEFAULT,"rsClearTemporalAovsTextures"));
    readAovDemand=reinterpret_cast<decltype(readAovDemand)>(dlsym(RTLD_DEFAULT,"rsGetSceneAovDemand"));
    setSceneCopy=reinterpret_cast<decltype(setSceneCopy)>(dlsym(RTLD_DEFAULT,"rsSetTemporalSceneCopyBoundary"));
    clearSceneCopies=reinterpret_cast<decltype(clearSceneCopies)>(dlsym(RTLD_DEFAULT,"rsClearTemporalSceneCopyBoundaries"));
    sceneCopyAPI=reinterpret_cast<decltype(sceneCopyAPI)>(dlsym(RTLD_DEFAULT,"rsSceneCopyBoundaryAPI"));
    Name name(className), parent("RefCounted"), empty(""); String emptyString("");
    GDExtensionClassCreationInfo2 creation{}; creation.is_exposed = true; creation.create_instance_func = create; creation.free_instance_func = freeInstance;
    registerClass(library, name.value, parent.value, &creation);
    const char *names[] = {"available", "method", "clear", "submit", "needs_scene", "submit_matrices", "submit_destination", "bind_window", "aov_demand", "acquire_aov_slot", "release_aov_slot", "submit_aovs", "retire_aovs", "aovs_idle", "resume_aovs", "submit_scene_copy", "clear_scene_copy", "stage", "stage_matrices", "scene_copy_available", "aov_slot_idle"};
    for (unsigned op = 0; op < 21; ++op) {
        Name method(names[op]);
        GDExtensionPropertyInfo result{op == Method||op==AovDemand||op==AovAcquire ? GDEXTENSION_VARIANT_TYPE_INT : GDEXTENSION_VARIANT_TYPE_BOOL, empty.value, empty.value, 0, emptyString.value, 6};
        std::array<GDExtensionPropertyInfo, 36> args{}; std::array<GDExtensionClassMethodArgumentMetadata, 36> metadata{};
        const unsigned count=argumentCount(Operation(op));
        for (unsigned i = 0; i < count; ++i) args[i] = {argumentType(Operation(op),i), empty.value, empty.value, 0, emptyString.value, 6};
        GDExtensionClassMethodInfo info{}; info.name = method.value; info.method_userdata = reinterpret_cast<void *>(uintptr_t(op));
        info.call_func = call; info.ptrcall_func = ptrcall; info.method_flags = GDEXTENSION_METHOD_FLAG_NORMAL;
        info.has_return_value = op != Clear; info.return_value_info = &result;
        info.argument_count = count; info.arguments_info = args.data(); info.arguments_metadata = metadata.data();
        registerMethod(library, name.value, &info);
    }
}
void deinitialize(void *, GDExtensionInitializationLevel level) {
    if (level == GDEXTENSION_INITIALIZATION_SCENE) { Name name(className); unregisterClass(library, name.value); }
}
}

extern "C" GDExtensionBool maclauncher_godot_camera_init(GDExtensionInterfaceGetProcAddress get,
    GDExtensionClassLibraryPtr handle, GDExtensionInitialization *initialization) {
    library = handle;
#define LOAD(variable, type, symbol) variable = reinterpret_cast<type>(get(symbol)); if (!variable) return false
    LOAD(nameNew, GDExtensionInterfaceStringNameNewWithUtf8Chars, "string_name_new_with_utf8_chars");
    LOAD(stringNew, GDExtensionInterfaceStringNewWithUtf8Chars, "string_new_with_utf8_chars");
    LOAD(destructor, GDExtensionInterfaceVariantGetPtrDestructor, "variant_get_ptr_destructor");
    LOAD(toType, GDExtensionInterfaceGetVariantToTypeConstructor, "get_variant_to_type_constructor");
    LOAD(fromType, GDExtensionInterfaceGetVariantFromTypeConstructor, "get_variant_from_type_constructor");
    LOAD(variantType, GDExtensionInterfaceVariantGetType, "variant_get_type");
    LOAD(newNil, GDExtensionInterfaceVariantNewNil, "variant_new_nil");
    LOAD(construct, GDExtensionInterfaceClassdbConstructObject, "classdb_construct_object");
    LOAD(setInstance, GDExtensionInterfaceObjectSetInstance, "object_set_instance");
    LOAD(registerClass, GDExtensionInterfaceClassdbRegisterExtensionClass2, "classdb_register_extension_class2");
    LOAD(registerMethod, GDExtensionInterfaceClassdbRegisterExtensionClassMethod, "classdb_register_extension_class_method");
    LOAD(unregisterClass, GDExtensionInterfaceClassdbUnregisterExtensionClass, "classdb_unregister_extension_class");
#undef LOAD
    initialization->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
    initialization->initialize = initialize; initialization->deinitialize = deinitialize; initialization->userdata = nullptr;
    return true;
}
extern "C" uint32_t maclauncher_godot_scene_aov_api() { return RS_SCENE_AOV_ABI_VERSION; }
extern "C" uint32_t maclauncher_godot_scene_copy_api() { return 1; }

#include <gdextension_interface.h>
#include "../../shared/reshade/temporal/camera.h"
#include "../../shared/reshade/temporal/frame.h"
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>

namespace {
using SetCamera = int (*)(void *, void *, void *, void *, const RSTemporalCamera *);
using ClearCamera = void (*)(void *);
using ReadMethod = uint32_t (*)();
SetCamera setCamera;
ClearCamera clearCamera;
ReadMethod readMethod;
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
struct Bridge {
    uint64_t submitted = 0;
    ~Bridge() { if (clearCamera) clearCamera(this); }
};
GDExtensionObjectPtr create(void *) {
    Name base("RefCounted"), name(className);
    auto object = construct(base.value);
    if (object) setInstance(object, name.value, new Bridge);
    return object;
}
void freeInstance(void *, GDExtensionClassInstancePtr instance) { delete static_cast<Bridge *>(instance); }
enum Operation { Available, Method, Clear, Submit };
constexpr std::array<GDExtensionVariantType, 9> argumentTypes = {
    GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT,
    GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_FLOAT,
    GDEXTENSION_VARIANT_TYPE_FLOAT, GDEXTENSION_VARIANT_TYPE_INT, GDEXTENSION_VARIANT_TYPE_INT
};
bool submit(Bridge *owner, const int64_t *integers, const double *numbers) {
    if (!setCamera || !clearCamera || !owner) return false;
    RSTemporalCamera camera{};
    camera.size = sizeof(camera); camera.version = 1;
    camera.flags = RS_TEMPORAL_DEPTH_REVERSED | RS_TEMPORAL_HDR;
    camera.frameId = uint64_t(integers[7]); camera.viewportId = uint64_t(integers[8]);
    camera.nearPlane = float(numbers[3]); camera.farPlane = float(numbers[4]);
    camera.verticalFov = float(numbers[5]); camera.frameTimeMs = float(numbers[6]);
    const auto status = setCamera(owner, reinterpret_cast<void *>(uintptr_t(integers[0])),
        reinterpret_cast<void *>(uintptr_t(integers[1])), reinterpret_cast<void *>(uintptr_t(integers[2])), &camera);
    if (status == RS_TEMPORAL_OK && owner->submitted++ == 0 && std::getenv("MACLAUNCHER_GODOT_GRAPHICS_TRACE"))
        std::fprintf(stderr, "[Godot graphics] Camera registered near=%g far=%g verticalFov=%g viewport=%llu\n",
            camera.nearPlane, camera.farPlane, camera.verticalFov, (unsigned long long)camera.viewportId);
    return status == RS_TEMPORAL_OK;
}
void call(void *operation, GDExtensionClassInstancePtr instance, const GDExtensionConstVariantPtr *args,
          GDExtensionInt count, GDExtensionVariantPtr output, GDExtensionCallError *error) {
    const auto op = Operation(uintptr_t(operation));
    const int expected = op == Submit ? int(argumentTypes.size()) : 0;
    error->error = GDEXTENSION_CALL_OK;
    if (count != expected) { newNil(output); error->error = count < expected ? GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS : GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS; error->expected = expected; return; }
    if (op == Method) { int64_t value = readMethod ? readMethod() : 0; fromType(GDEXTENSION_VARIANT_TYPE_INT)(output, &value); return; }
    auto owner = static_cast<Bridge *>(instance);
    if (op == Clear) { if (clearCamera) clearCamera(owner); newNil(output); return; }
    GDExtensionBool result = setCamera && clearCamera && readMethod;
    if (op == Submit) {
        std::array<int64_t, 9> integers{}; std::array<double, 9> numbers{};
        for (unsigned i = 0; i < argumentTypes.size(); ++i) {
            const auto actual = variantType(args[i]);
            if (actual != argumentTypes[i] && !(argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_FLOAT && actual == GDEXTENSION_VARIANT_TYPE_INT)) {
                newNil(output); error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT; error->argument = i; error->expected = argumentTypes[i]; return;
            }
            if (argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_INT) toType(argumentTypes[i])(&integers[i], const_cast<void *>(args[i]));
            else toType(argumentTypes[i])(&numbers[i], const_cast<void *>(args[i]));
        }
        result = submit(owner, integers.data(), numbers.data());
    }
    fromType(GDEXTENSION_VARIANT_TYPE_BOOL)(output, &result);
}
void ptrcall(void *operation, GDExtensionClassInstancePtr instance, const GDExtensionConstTypePtr *args, GDExtensionTypePtr output) {
    const auto op = Operation(uintptr_t(operation)); auto owner = static_cast<Bridge *>(instance);
    if (op == Method) { *static_cast<int64_t *>(output) = readMethod ? readMethod() : 0; return; }
    if (op == Clear) { if (clearCamera) clearCamera(owner); return; }
    bool result = setCamera && clearCamera && readMethod;
    if (op == Submit) {
        std::array<int64_t, 9> integers{}; std::array<double, 9> numbers{};
        for (unsigned i = 0; i < argumentTypes.size(); ++i)
            if (argumentTypes[i] == GDEXTENSION_VARIANT_TYPE_INT) integers[i] = *static_cast<const int64_t *>(args[i]);
            else numbers[i] = *static_cast<const double *>(args[i]);
        result = submit(owner, integers.data(), numbers.data());
    }
    *static_cast<GDExtensionBool *>(output) = result;
}
void initialize(void *, GDExtensionInitializationLevel level) {
    if (level != GDEXTENSION_INITIALIZATION_SCENE) return;
    setCamera = reinterpret_cast<SetCamera>(dlsym(RTLD_DEFAULT, "rsSetTemporalCameraForTextures"));
    clearCamera = reinterpret_cast<ClearCamera>(dlsym(RTLD_DEFAULT, "rsClearTemporalCameraTextures"));
    readMethod = reinterpret_cast<ReadMethod>(dlsym(RTLD_DEFAULT, "rsGetTemporalMethod"));
    Name name(className), parent("RefCounted"), empty(""); String emptyString("");
    GDExtensionClassCreationInfo2 creation{}; creation.is_exposed = true; creation.create_instance_func = create; creation.free_instance_func = freeInstance;
    registerClass(library, name.value, parent.value, &creation);
    const char *names[] = {"available", "method", "clear", "submit"};
    for (unsigned op = 0; op < 4; ++op) {
        Name method(names[op]);
        GDExtensionPropertyInfo result{op == Method ? GDEXTENSION_VARIANT_TYPE_INT : GDEXTENSION_VARIANT_TYPE_BOOL, empty.value, empty.value, 0, emptyString.value, 6};
        std::array<GDExtensionPropertyInfo, 9> args{}; std::array<GDExtensionClassMethodArgumentMetadata, 9> metadata{};
        for (unsigned i = 0; i < args.size(); ++i) args[i] = {argumentTypes[i], empty.value, empty.value, 0, emptyString.value, 6};
        GDExtensionClassMethodInfo info{}; info.name = method.value; info.method_userdata = reinterpret_cast<void *>(uintptr_t(op));
        info.call_func = call; info.ptrcall_func = ptrcall; info.method_flags = GDEXTENSION_METHOD_FLAG_NORMAL;
        info.has_return_value = op != Clear; info.return_value_info = &result;
        info.argument_count = op == Submit ? args.size() : 0; info.arguments_info = args.data(); info.arguments_metadata = metadata.data();
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

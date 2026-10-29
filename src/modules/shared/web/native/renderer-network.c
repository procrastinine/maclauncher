// Node-API v1 uses opaque C handles and a stable ABI across Node/Electron.
// These declarations avoid coupling the helper to a particular V8 build.
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>
#include <sandbox.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_get_value_string_utf8(napi_env, napi_value, char *, size_t, size_t *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern int napi_get_undefined(napi_env, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);

static pthread_mutex_t policy_lock = PTHREAD_MUTEX_INITIALIZER;
static char applied_policy[4096];

static napi_value apply(napi_env env, napi_callback_info info) {
    napi_value argv[1], result;
    size_t argc = 1, size = 0;
    char policy[sizeof(applied_policy)];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) || argc != 1 ||
        napi_get_value_string_utf8(env, argv[0], NULL, 0, &size) || !size || size >= sizeof(policy) ||
        napi_get_value_string_utf8(env, argv[0], policy, sizeof(policy), &size) || strlen(policy) != size) {
        napi_throw_error(env, "ERR_NETWORK_POLICY", "The game network policy is invalid.");
        return NULL;
    }
    pthread_mutex_lock(&policy_lock);
    if (applied_policy[0]) {
        const int same = strcmp(policy, applied_policy) == 0;
        pthread_mutex_unlock(&policy_lock);
        if (!same) {
            napi_throw_error(env, "ERR_NETWORK_POLICY", "The game renderer already has a different network policy.");
            return NULL;
        }
    } else {
        char *error = NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        const int status = sandbox_init(policy, 0, &error);
#pragma clang diagnostic pop
        if (status != 0) {
            pthread_mutex_unlock(&policy_lock);
            napi_throw_error(env, "ERR_NETWORK_POLICY", error ? error : "macOS could not apply the game network policy.");
            if (error) sandbox_free_error(error);
            return NULL;
        }
        memcpy(applied_policy, policy, size + 1);
        pthread_mutex_unlock(&policy_lock);
    }
    napi_get_undefined(env, &result);
    return result;
}

__attribute__((visibility("default")))
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_value function;
    if (napi_create_function(env, "apply", 5, apply, NULL, &function) ||
        napi_set_named_property(env, exports, "apply", function)) return NULL;
    return exports;
}

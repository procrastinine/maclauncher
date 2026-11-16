// maclauncher-vulkan-features DRIVER
// Prints the Vulkan 1.0 device features that a Vulkan driver (ICD) library
// reports, as one JSON line. The driver is loaded directly through its ICD
// entry point (vk_icdGetInstanceProcAddr), without a Vulkan loader, so the
// answer is the driver's own. Exit status 0 means the driver answered.
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef uint32_t VkBool32;
typedef int32_t VkResult;
typedef struct VkInstance_T *VkInstance;
typedef struct VkPhysicalDevice_T *VkPhysicalDevice;
typedef void (*PFN_vkVoidFunction)(void);
typedef PFN_vkVoidFunction (*PFN_vkGetInstanceProcAddr)(VkInstance, const char *);
typedef VkResult (*PFN_vkNegotiateLoaderICDInterfaceVersion)(uint32_t *);
typedef struct {
  int32_t sType; const void *pNext; const char *pApplicationName; uint32_t applicationVersion;
  const char *pEngineName; uint32_t engineVersion; uint32_t apiVersion;
} VkApplicationInfo;
typedef struct {
  int32_t sType; const void *pNext; uint32_t flags; const VkApplicationInfo *pApplicationInfo;
  uint32_t enabledLayerCount; const char *const *ppEnabledLayerNames;
  uint32_t enabledExtensionCount; const char *const *ppEnabledExtensionNames;
} VkInstanceCreateInfo;
typedef VkResult (*PFN_vkCreateInstance)(const VkInstanceCreateInfo *, const void *, VkInstance *);
typedef void (*PFN_vkDestroyInstance)(VkInstance, const void *);
typedef VkResult (*PFN_vkEnumeratePhysicalDevices)(VkInstance, uint32_t *, VkPhysicalDevice *);
typedef void (*PFN_vkGetPhysicalDeviceFeatures)(VkPhysicalDevice, VkBool32 *);
typedef void (*PFN_vkGetPhysicalDeviceProperties)(VkPhysicalDevice, unsigned char *);

// VkPhysicalDeviceFeatures, in declaration order.
static const char *const FEATURES[] = {
  "robustBufferAccess", "fullDrawIndexUint32", "imageCubeArray", "independentBlend", "geometryShader", "tessellationShader",
  "sampleRateShading", "dualSrcBlend", "logicOp", "multiDrawIndirect", "drawIndirectFirstInstance", "depthClamp", "depthBiasClamp",
  "fillModeNonSolid", "depthBounds", "wideLines", "largePoints", "alphaToOne", "multiViewport", "samplerAnisotropy",
  "textureCompressionETC2", "textureCompressionASTC_LDR", "textureCompressionBC", "occlusionQueryPrecise", "pipelineStatisticsQuery",
  "vertexPipelineStoresAndAtomics", "fragmentStoresAndAtomics", "shaderTessellationAndGeometryPointSize", "shaderImageGatherExtended",
  "shaderStorageImageExtendedFormats", "shaderStorageImageMultisample", "shaderStorageImageReadWithoutFormat",
  "shaderStorageImageWriteWithoutFormat", "shaderUniformBufferArrayDynamicIndexing", "shaderSampledImageArrayDynamicIndexing",
  "shaderStorageBufferArrayDynamicIndexing", "shaderStorageImageArrayDynamicIndexing", "shaderClipDistance", "shaderCullDistance",
  "shaderFloat64", "shaderInt64", "shaderInt16", "shaderResourceResidency", "shaderResourceMinLod", "sparseBinding",
  "sparseResidencyBuffer", "sparseResidencyImage2D", "sparseResidencyImage3D", "sparseResidency2Samples", "sparseResidency4Samples",
  "sparseResidency8Samples", "sparseResidency16Samples", "sparseResidencyAliased", "variableMultisampleRate", "inheritedQueries"};
enum { FEATURE_COUNT = sizeof(FEATURES) / sizeof(FEATURES[0]) };

static void printString(const char *text) {
  putchar('"');
  for (const unsigned char *at = (const unsigned char *)text; *at; at++) {
    if (*at == '"' || *at == '\\') printf("\\%c", *at);
    else if (*at < 0x20) printf("\\u%04x", *at);
    else putchar(*at);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: maclauncher-vulkan-features DRIVER\n"); return 2; }
  void *driver = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!driver) { fprintf(stderr, "%s\n", dlerror()); return 3; }
  PFN_vkNegotiateLoaderICDInterfaceVersion negotiate = (PFN_vkNegotiateLoaderICDInterfaceVersion)dlsym(driver, "vk_icdNegotiateLoaderICDInterfaceVersion");
  if (negotiate) { uint32_t version = 5; if (negotiate(&version) != 0) { fprintf(stderr, "The driver refused ICD interface negotiation.\n"); return 4; } }
  PFN_vkGetInstanceProcAddr proc = (PFN_vkGetInstanceProcAddr)dlsym(driver, "vk_icdGetInstanceProcAddr");
  if (!proc) { fprintf(stderr, "The library is not a Vulkan driver: vk_icdGetInstanceProcAddr is missing.\n"); return 3; }
  PFN_vkCreateInstance createInstance = (PFN_vkCreateInstance)proc(NULL, "vkCreateInstance");
  if (!createInstance) { fprintf(stderr, "vkCreateInstance is missing.\n"); return 4; }
  VkApplicationInfo application = {0, NULL, "MacLauncher", 1, "MacLauncher", 1, (1u << 22)};
  VkInstanceCreateInfo create = {1, NULL, 0, &application, 0, NULL, 0, NULL};
  VkInstance instance = NULL;
  VkResult result = createInstance(&create, NULL, &instance);
  if (result != 0 || !instance) { fprintf(stderr, "vkCreateInstance failed: %d\n", result); return 4; }
  PFN_vkEnumeratePhysicalDevices enumerate = (PFN_vkEnumeratePhysicalDevices)proc(instance, "vkEnumeratePhysicalDevices");
  PFN_vkGetPhysicalDeviceFeatures features = (PFN_vkGetPhysicalDeviceFeatures)proc(instance, "vkGetPhysicalDeviceFeatures");
  PFN_vkGetPhysicalDeviceProperties properties = (PFN_vkGetPhysicalDeviceProperties)proc(instance, "vkGetPhysicalDeviceProperties");
  PFN_vkDestroyInstance destroy = (PFN_vkDestroyInstance)proc(instance, "vkDestroyInstance");
  if (!enumerate || !features || !properties) { fprintf(stderr, "The driver lacks Vulkan 1.0 device queries.\n"); return 4; }
  VkPhysicalDevice devices[16]; uint32_t count = 16;
  result = enumerate(instance, &count, devices);
  if ((result != 0 && result != 5) || count == 0) { fprintf(stderr, "No Vulkan device: %d\n", result); if (destroy) destroy(instance, NULL); return 4; }
  printf("{\"schema\":1,\"devices\":[");
  for (uint32_t index = 0; index < count; index++) {
    // VkPhysicalDeviceProperties holds deviceName[256] after five 32-bit fields.
    unsigned char props[4096]; memset(props, 0, sizeof(props)); properties(devices[index], props);
    char name[257]; memcpy(name, props + 20, 256); name[256] = 0;
    VkBool32 values[FEATURE_COUNT + 8]; memset(values, 0, sizeof(values)); features(devices[index], values);
    printf("%s{\"name\":", index ? "," : ""); printString(name); printf(",\"features\":{");
    for (int feature = 0; feature < FEATURE_COUNT; feature++)
      printf("%s\"%s\":%s", feature ? "," : "", FEATURES[feature], values[feature] ? "true" : "false");
    printf("}}");
  }
  printf("]}\n");
  if (destroy) destroy(instance, NULL);
  return 0;
}

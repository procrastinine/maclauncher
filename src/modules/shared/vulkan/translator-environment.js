// Environment variables of the Vulkan drivers. MoltenVK names follow its
// MVKConfiguration parameters; KosmicKrisp names follow Mesa's KosmicKrisp
// driver, disk cache and window-system code. The launcher points the Vulkan
// loader at the selected driver (index.js driverEnvironment), so those
// variables are locked.
const loader = [
  { key: "VK_DRIVER_FILES", reason: "Points the Vulkan loader at the selected driver." },
  { key: "VK_ICD_FILENAMES", reason: "Points the Vulkan loader at the selected driver." },
  { key: "KL_MVK_DYLIB", reason: "Names the selected Vulkan library for Android." },
  { key: "CX_LIBVULKAN", reason: "Names the selected Vulkan library for CrossOver." }
];
const loaderDebug = { key: "VK_LOADER_DEBUG", description: "Vulkan loader messages: error, warn, info, debug, driver or all." };
module.exports = [
  { id: "moltenvk", label: "MoltenVK", managerIds: ["vulkan-moltenvk"],
    description: "Applies to games whose Vulkan driver is MoltenVK.",
    keys: [
      { key: "MVK_CONFIG_LOG_LEVEL", description: "Log detail: 0 none, 1 errors, 2 warnings, 3 information, 4 debug." },
      { key: "MVK_CONFIG_FAST_MATH_ENABLED", description: "Metal fast math: 0 never, 1 always, 2 when a shader requests it.", launcher: "Set by MoltenVK fast math in the Runtime Settings of Wine games." },
      { key: "MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS", description: "1 places descriptors in Metal argument buffers.", launcher: "Set by MoltenVK argument buffers in the Runtime Settings of Wine games." },
      { key: "MVK_CONFIG_UE4_HACK_ENABLED", description: "1 turns on MoltenVK's workarounds for Unreal Engine 4 games.", launcher: "Set by MoltenVK UE4 compatibility in the Runtime Settings of Wine games." },
      { key: "MVK_CONFIG_SYNCHRONOUS_QUEUE_SUBMITS", description: "1 processes queue submissions on the calling thread." },
      { key: "MVK_CONFIG_PREFILL_METAL_COMMAND_BUFFERS", description: "Metal command buffer filling: 0 at submission, 1 deferred, 2 immediate, 3 immediate without autorelease pools." },
      { key: "MVK_CONFIG_MAX_ACTIVE_METAL_COMMAND_BUFFERS_PER_QUEUE", description: "Number of Metal command buffers a queue may have in flight." },
      { key: "MVK_CONFIG_USE_MTLHEAP", description: "Resource heaps: 0 never, 1 where safe, 2 always." },
      { key: "MVK_CONFIG_RESUME_LOST_DEVICE", description: "1 keeps the device usable after a GPU error." },
      { key: "MVK_CONFIG_SHADER_COMPRESSION_ALGORITHM", description: "Compression of cached shader source: 0 none, 1 LZFSE, 2 ZLIB, 3 LZ4, 4 LZMA." },
      { key: "MVK_CONFIG_SWAPCHAIN_MIN_MAG_FILTER_USE_NEAREST", description: "1 scales the swap chain with nearest-neighbor sampling." },
      { key: "MVK_CONFIG_SPECIALIZED_QUEUE_FAMILIES", description: "1 offers separate queue families for graphics, compute and transfer." },
      { key: "MVK_CONFIG_PERFORMANCE_TRACKING", description: "1 collects performance statistics." },
      { key: "MVK_CONFIG_ACTIVITY_PERFORMANCE_LOGGING_STYLE", description: "When performance statistics are logged: 0 by frame count, 1 immediately, 2 when the device ends." },
      { key: "MVK_CONFIG_DEBUG", description: "1 adds debugging information to converted shaders and logs." },
      loaderDebug
    ],
    locked: loader },
  { id: "kosmickrisp", label: "KosmicKrisp", managerIds: ["vulkan-kosmickrisp", "maclauncher-kosmickrisp"],
    description: "Applies to games whose Vulkan driver is a KosmicKrisp build.",
    keys: [
      { key: "MESA_KK_DEBUG", description: "Driver debugging flags: msl, force_robustness or force_per_vertex_buffer." },
      { key: "KK_EMULATION", description: "Emulated features, comma-separated and applied left to right. Unset or performance: the fast set for this Mac's Apple GPU generation, detected automatically. conformance: every emulated feature (Direct3D 12 feature level 12_2, shader model 6.9). apple7 through apple11 or mode=7 through mode=11: also turn on the features that generation runs natively. +name or -name: one feature on or off, with the names in the KosmicKrisp documentation. -VK_extension_name hides an extension." },
      { key: "MESA_KK_EXPERIMENTAL", description: "Experimental features: custom_border, image_view_min_lod, optimize_e5b9g9r9 or all. The driver's default is custom_border,image_view_min_lod." },
      { key: "MESA_KK_DISABLE_WORKAROUNDS", description: "Workaround numbers to turn off, separated by commas, or all." },
      { key: "MESA_KK_GPU_CAPTURE", description: "true records a Metal GPU capture." },
      { key: "MESA_KK_GPU_CAPTURE_DIRECTORY", description: "Folder that receives Metal GPU captures." },
      { key: "MESA_SHADER_CACHE_DIR", description: "Folder for Mesa's shader cache." },
      { key: "MESA_SHADER_CACHE_DISABLE", description: "true turns off Mesa's shader cache." },
      { key: "MESA_SHADER_CACHE_MAX_SIZE", description: "Largest shader cache size, such as 1G or 512M." },
      { key: "MESA_VK_WSI_PRESENT_MODE", description: "Present mode: immediate, mailbox, fifo or relaxed." },
      { key: "MESA_VK_ABORT_ON_DEVICE_LOSS", description: "true stops the process when the GPU device is lost." },
      { key: "MESA_VK_ENABLE_SUBMIT_THREAD", description: "true submits queue work on a separate thread." },
      loaderDebug
    ],
    locked: loader }
];

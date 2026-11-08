// Environment variables of the Direct3D translators and video codecs that Wine
// runtimes load. Names and meanings follow each project's documentation and
// source; launcher values come from src/modules/shared/runtime/wine-settings.js
// and the DLSS integration in src/modules/crossover/dlss.js.
const temporal = "Set by Game temporal integration in Runtime Settings.";
module.exports = [
  { id: "dxvk", label: "DXVK", managerIds: ["translator-dxvk", "dxvk"],
    description: "Applies to games whose Direct3D 8, 9, 10 or 11 choice uses DXVK, D8VK or D9VK.",
    keys: [
      { key: "DXVK_CONFIG", description: "dxvk.conf options separated by semicolons, such as dxvk.enableAsync = True." },
      { key: "DXVK_CONFIG_FILE", description: "Path of a dxvk.conf file." },
      { key: "DXVK_HUD", description: "On-screen HUD elements, such as fps, frametimes, compiler or full.", launcher: "Set by DXVK HUD in Runtime Settings." },
      { key: "DXVK_ASYNC", description: "1 compiles shaders asynchronously in DXVK async builds.", launcher: "Set by DXVK async in Runtime Settings." },
      { key: "DXVK_LOG_LEVEL", description: "Log detail: none, error, warn, info or debug." },
      { key: "DXVK_LOG_PATH", description: "Folder for DXVK log files, or none to write no log files." },
      { key: "DXVK_SHADER_CACHE", description: "0 turns off DXVK's internal shader cache." },
      { key: "DXVK_SHADER_CACHE_PATH", description: "Folder for DXVK's internal shader cache." },
      { key: "DXVK_STATE_CACHE_PATH", description: "Folder for the pipeline state cache of DXVK 2.6 and earlier." },
      { key: "DXVK_FILTER_DEVICE_NAME", description: "Uses the Vulkan device whose name contains this text." },
      { key: "DXVK_ENABLE_NVAPI", description: "1 exposes NVIDIA adapters to NVAPI." },
      { key: "DXVK_DEBUG", description: "Debugging mode, such as markers or validation." }
    ] },
  { id: "vkd3d-proton", label: "vkd3d-proton", managerIds: ["translator-vkd3d-proton"],
    description: "Applies to games whose Direct3D 12 choice uses vkd3d-proton.",
    keys: [
      { key: "VKD3D_CONFIG", description: "Options separated by commas, such as nodxr or single_queue." },
      { key: "VKD3D_DEBUG", description: "Log detail: none, err, info, fixme, warn or trace." },
      { key: "VKD3D_SHADER_DEBUG", description: "Log detail of the shader compilers, with the VKD3D_DEBUG values." },
      { key: "VKD3D_LOG_FILE", description: "File that receives the log instead of the standard error output." },
      { key: "VKD3D_SHADER_CACHE_PATH", description: "Folder for vkd3d-proton.cache, or 0 to turn the cache off." },
      { key: "VKD3D_FRAME_RATE", description: "Frame rate limit; 0 removes the limit." },
      { key: "VKD3D_SWAPCHAIN_PRESENT_MODE", description: "Present mode: IMMEDIATE, MAILBOX, FIFO or FIFO_RELAXED." },
      { key: "VKD3D_FILTER_DEVICE_NAME", description: "Uses a Vulkan device whose name contains this text." },
      { key: "VKD3D_DISABLE_EXTENSIONS", description: "Vulkan extensions that vkd3d-proton does not use." }
    ] },
  { id: "dxmt", label: "DXMT", managerIds: ["sikarugir-graphics-bridge"],
    description: "Applies to games whose Direct3D 10 or 11 choice uses DXMT.",
    keys: [
      { key: "DXMT_CONFIG", description: "Options separated by semicolons, such as d3d11.preferredMaxFrameRate=60.", launcher: "Set by DXMT configuration in Runtime Settings." },
      { key: "DXMT_CONFIG_FILE", description: "Path of a DXMT configuration file." },
      { key: "DXMT_LOG_LEVEL", description: "Log detail: none, error, warn, info or debug." },
      { key: "DXMT_LOG_PATH", description: "Folder for DXMT log files." },
      { key: "DXMT_SHADER_CACHE", description: "0 turns off DXMT's shader cache." },
      { key: "DXMT_SHADER_CACHE_PATH", description: "Folder for DXMT's shader cache." },
      { key: "DXMT_METALFX_SPATIAL_SWAPCHAIN", description: "1 upscales the swap chain with MetalFX spatial scaling.", launcher: "Set by MetalFX spatial in Runtime Settings." },
      { key: "DXMT_ENABLE_NVEXT", description: "1 exposes NVIDIA extensions for DLSS through MetalFX.", launcher: temporal }
    ] },
  { id: "d3dmetal", label: "D3DMetal", managerIds: ["translator-d3dmetal"],
    description: "Applies to games whose Direct3D 11 or 12 choice uses D3DMetal.",
    keys: [
      { key: "D3DM_SUPPORT_DXR", description: "1 exposes DirectX Raytracing on Macs that support it." },
      { key: "D3DM_ENABLE_METALFX", description: "1 translates DLSS requests to MetalFX.", launcher: temporal },
      { key: "D3DM_MAX_FPS", description: "Frame rate limit.", launcher: "Set by D3DMetal FPS limit in Runtime Settings." },
      { key: "D3DM_MTL4", description: "1 renders with Metal 4 where available.", launcher: "Set by D3DMetal Metal 4 in Runtime Settings." },
      { key: "D3DM_VENDOR_ID", description: "PCI vendor ID that the adapter reports to the game." },
      { key: "D3DM_DEVICE_ID", description: "PCI device ID that the adapter reports to the game." },
      { key: "D3DM_DEVICE_DESCRIPTION", description: "Adapter name that the game sees." }
    ] },
  { id: "gstreamer", label: "GStreamer codecs", managerIds: ["translator-gstreamer"],
    description: "Applies to games whose video codec choice is a registered GStreamer folder.",
    keys: [
      { key: "GST_DEBUG", description: "Log detail by category, such as 2 or *:3." },
      { key: "GST_DEBUG_FILE", description: "File that receives the GStreamer log." },
      { key: "GST_DEBUG_NO_COLOR", description: "1 writes the log without color codes." }
    ],
    locked: [{ prefix: "GST_PLUGIN_", reason: "The codec choice sets the plugin folders." },
      { prefix: "GST_REGISTRY", reason: "The launcher keeps the plugin registry with the codec folder." }] }
];

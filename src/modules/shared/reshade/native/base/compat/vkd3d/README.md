# Binary shader translation

This target builds vkd3d-shader 2.1 from the pinned upstream source for DXBC/DXIL and legacy Direct3D bytecode translation. HLSL, effect and texture authoring are excluded and not advertised. The library is loaded from beside the native processor; no Wine, Vulkan driver or shader authoring tools are required.

The unchanged generated headers in include/ come from the official 2.1 source archive https://dl.winehq.org/vkd3d/source/vkd3d-2.1.tar.xz (SHA-256: 7510146aff2adfb4ae07ab890701a607e5ff7c66e57100cfc9f630ec92eeda6a). The upstream commit is fb7f9ff3c1f8d972ee6f1b8c6a92caf6c8ba1e10. spirv_grammar.h retains its Khronos license and generator/version notice; vkd3d_d3dx9shader.h is generated from the pinned vkd3d_d3dx9shader.idl by WIDL 11.9. All consumed translation C sources match the same release.

The vkd3d sources and owned frontend stubs are LGPL-2.1-or-later. The separate shared library remains replaceable with a compatible vkd3d-shader implementation. Proprietary model bytecode is read only from an explicitly selected local file and is never included in this target.

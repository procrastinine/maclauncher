# FidelityFX API adapter

The proxy keeps the five FidelityFX API 1.0.1 exports and loads the game's own
library, renamed beside it, for every context, configuration, query and frame
generation call. The declared SDK is 1.1.4; the reference DLL's embedded file
version is 1.0.1.41314. These are separate versions.

Each upscale dispatch on a context whose device forwards MacLauncher temporal
frames is recorded as one `VkTemporalFrameInfoMVK` (`vk_temporal_frame.h` in
MacLauncher Builds' VKD3D-Proton producer), with the reactive and
transparency-and-composition masks in a chained `VkTemporalFrameMasksInfoMVK`.
MacLauncher's selected upscaler then writes the dispatch's output:

- Vulkan backend: the proxy reads the physical device's `driverInfo` at context
  creation. When it names `temporal-sr` and the device has
  `vkCmdPipelineBarrier2`, each dispatch records the frame in its command
  buffer, followed by a plain barrier. The context's feature id is released in
  the next recorded frame after the context is destroyed.
- Direct3D 12 backend: the proxy records each dispatch through
  `ID3D12GraphicsCommandListMetalFX::TemporalUpscale` (`vkd3d_metalfx.h`). The
  context's scaler is destroyed with the context.

A dispatch that cannot be recorded runs the original. While the game's
Graphics are off, every dispatch runs the original, and the first dispatch after
each switch has its reset flag set. `../graphics-state.hpp` gives that state
without file I/O on the dispatch: it follows `effect-plan.active` beside the
game's `RESHADE_EFFECT_PLAN` from a background thread every 100 ms. `carrier.hpp` maps a
dispatch onto `VKD3D_METALFX_TEMPORAL_DESC`; `scalar-mapping.hpp` holds the
scalar and flag conventions, including camera planes for inverted and infinite
depth.

MacLauncher Builds builds the proxies with
`producers/package-support/src/modules/crossover/temporal/fidelityfx/build.mjs`.
It uses the exact FidelityFX SDK and Vulkan-Headers commits declared in the
`source.json` beside it, and the carrier headers of the VKD3D-Proton producer.
Each backend compiles separately, because the SDK's Vulkan and Direct3D 12
headers declare the same frame generation keys:

```sh
node build.mjs --sdk-source SDK_CHECKOUT --vulkan-source VULKAN_HEADERS_CHECKOUT \
  --carrier-headers VKD3D_PROTON_PRODUCER --compiler MINGW_CLANGXX --out OUTPUT_DIRECTORY
```

Each backend's reference library is read from the pinned SDK's Git object at its
declared path and verified against its SHA-256; its export table and ordinals
become the proxy's. `payload/` contains the runtime manifest, the provider
descriptor (schema 2, one entry per backend), both proxies and notices.
`runtime-package.json` is the standard package declaration for
`tools/runtime-package.mjs` in MacLauncher Builds.

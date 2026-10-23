# FSR Metal providers

These providers execute AMD FidelityFX Super Resolution 2.2.1 and FSR 3.1.4 temporal upscaling on Metal. Each uses its original AMD CPU scheduler and HLSL algorithms. An offline build translates HLSL through DXC and SPIRV-Cross to Metal shading language. Metal compiles the selected pipelines once when a context is created. No shader compiler tools are required in the installed app.

The providers implement `RSTemporalProvider` version 1 from `../frame.h`. FSR2 advertises method bit `1 << RS_TEMPORAL_FSR2`; FSR3 advertises `1 << RS_TEMPORAL_FSR3`. The FSR3 provider performs temporal upscaling and optional RCAS sharpening.

## Frame inputs

Each frame requires color, depth, motion vectors and a writable output texture on the same Metal device. Textures are single-sample 2D images. Color, depth and motion vectors describe the same scene frame before UI composition. Scene regions start at texture origin; output dimensions match the output texture. Motion vectors may be at render or output resolution, selected by `RS_TEMPORAL_OUTPUT_MOTION`. Input values follow the AMD dispatch conventions: jitter is measured in render pixels, motion scale converts stored vectors to pixel displacement, pre-exposure is positive, frame time is in milliseconds, and vertical field of view is in radians.

`RS_TEMPORAL_CAMERA_VALID` indicates that near plane, far plane and field of view come from the renderer. These camera values are required; they are not inferred from captured color. Reversed and infinite depth, HDR, jittered motion and automatic exposure have separate flags. Optional exposure, reactive and transparency/composition textures are passed to the AMD scheduler. Sharpness enables the RCAS pass when greater than zero.

Near and far planes use positive physical view-space distances. Infinite depth uses a zero far plane with `RS_TEMPORAL_DEPTH_INFINITE`; the provider converts this to FidelityFX's infinite-plane representation and orders the SDK planes according to the depth direction. Native `Depth32Float` and `Depth32Float_Stencil8` textures supply the depth channel directly.

Contexts are independent per owner. Changes to output size, maximum render size, device or initialization flags create a new context. A reset flag or a gap in frame identifiers resets accumulation. The provider accepts one pending frame per owner and returns `RS_TEMPORAL_BUSY` until its command buffer completes. It retains history resources through completion, including after owner release. Encoding neither submits nor waits for the caller's command buffer.

Image atomics use SPIRV-Cross's atomic buffer alias for buffer-backed `R32Uint` textures. The Metal texture row alignment is supplied through the corresponding specialization constant. Atomic operations retain their original semantics.

## Build and payload

`build.mjs <source> <compiler-bin-directory> <output>` builds FSR2. Add `--fsr3` with a FidelityFX SDK source checkout to build FSR3. The compiler directory contains `dxc` and `spirv-cross`. Source revisions and MIT license identities are recorded in `source.json`; the build requires those revisions. Both calls may use the same output directory. `--native-only` rebuilds native code using previously generated shader resources and checks their presence before writing metadata.

The build emits signed universal `arm64`/`x86_64` providers for macOS 13 or later. `payload/` contains the provider libraries, Metal shaders, binding metadata and AMD license notices. Runtime staging places that directory at `temporal/fsr`. `index.js` resolves available algorithms without network access and supplies `RESHADE_FSR2_LIBRARY`, `RESHADE_FSR3_LIBRARY` and `RESHADE_FSR_SHADER_DIRECTORY`.

The FSR3 host overlay adjusts opaque context capacity for Darwin's four-byte `wchar_t`, preserving the upstream context-size assertion and platform C library ABI. The compatibility header maps bounded Windows CRT array helpers to their native equivalents. Rendering algorithms and scheduling remain in the pinned AMD sources.

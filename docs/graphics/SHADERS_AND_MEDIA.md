# Shader, model and media integration

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

Shader formats, neural model files and video files each connect to MacLauncher's shared effect graph through a fixed interface. Native decoder phases and file export keep their own data and timing.

This page describes the shader provider interface and the resources it prepares, how a shader's declared geometry selects its row type, named scene inputs, shader analysis, native mpv video prefixes, model storage and import, and video preview and export. The [provider reference](PROVIDERS.md) lists each shader format and algorithm with its requirements, and the [shader library](README.md#shader-library) describes the library as the editor presents it.

[Shader provider interface](#shader-provider-interface) · [Prepared resources](#prepared-resources) · [Managed collections](#managed-collections) · [Shader output sizing](#shader-output-sizing) · [Named scene inputs](#named-scene-inputs) · [Shader analysis](#shader-analysis) · [Native video prefixes](#native-video-prefixes) · [Model storage and import](#model-storage-and-import) · [Video preview and export](#video-preview-and-export)

## Shader provider interface

Shader providers share the `ShaderNode` interface: an explicit selection, parameters for each row, and an `encode` call that uses the caller's command buffer and textures. Each provider keeps its own compiled resources and histories, while the shared executor manages the row order and the intermediate targets and the presenter handles submission and display timing. GPU resources stay alive until the reads submitted for them finish, including after a row is replaced or removed.

- Uniforms that the host writes for a model are copied into each encoded dispatch, so their values survive when later phases share the same command buffer.
- LSFG phases reuse temporary images within their serialized graph, and keep separate generated outputs and temporal history for each encoder.
- An ordered execution holds at most four sets of intermediate scratch images. When all are in use, it returns busy. Completion or abandonment releases the exact set, even when the caller keeps a completed command buffer.
- Explicit diagnostic frame capture uses the game's private effects directory and reads back only the requested frames. Ordinary processing and intermediate effect passes need no image readback.

### ReShade FX chains

A ReShade FX chain reads its input in place when the input has the chain's working size and format and allows shader reads and pixel-format views. Otherwise, it copies the input into its first working image. A back-buffer pass starts from a copy of the current image only when it can leave pixels unwritten, which happens with blending, a partial write mask, stencil, a partial viewport, `discard`, or a vertex shader other than the global `PostProcessVS` triangle.

The last full-screen pass of an unscaled chain renders straight into the output when the output is a single-sample, single-level 2D render target in the working format. Under the same conditions, the final FX row of an ordered graph renders into the graph's output, so no final copy follows it.

### FSR 1 scratch images

FSR 1 scratch images come from one pool per Metal device, keyed by size and format. Every FSR 1 encoder shares the pool, and its images count toward a 256 MiB budget for the process, about four 3840×2160 images. A replacement graph at the same output size reuses the idle images of the graph it replaces. An idle image is released once no live encoder's latest output uses its size and format, so a resize, a drawable change or a discarded graph leaves no stale image counted. When the budget is full, idle images of another encoder's size are released before a request is refused.

### Input color policy

A prepared shader row can declare `inputPolicy: "source" | "srgb-sdr" | "linear-source"`. The shared executor performs the selected conversion, taking into account the source primaries, transfer, alpha and whether the image was already mapped for display. The policy is part of the key that identifies the row's resources and history, and a conflicting or invalid declaration rejects the prepared plan.

| Policy | Input the shader receives |
| --- | --- |
| `srgb-sdr` | An eight-bit display back buffer. Legacy ReShadeFX compilation selects this policy. |
| `source` | The supplied image encoding, unchanged. Missing metadata is never invented. An HDR-aware FX entry opts in with a `//!INPUT_POLICY source` comment. |
| `linear-source` | The supplied transfer function decoded, keeping the source primaries, reference white and signed floating-point values. The executor returns the result to the source encoding and alpha convention after the row. It needs the graphics processor's `linearInputPolicyAPI`, and an authored entry selects it with `//!INPUT_POLICY linear-source`. |

`linear-source` uses the same prepared conversion as the other policies, and a row with it stays in the shared graph when a native video prefix cannot provide that conversion. Alpha written by a shader stays part of its output, while neural model adapters carry the source alpha separately.

## Prepared resources

Slang and libplacebo preparation uses a resource inventory with checksums and a content-addressed cache under `userData/graphics/shaders/`. Each game's selections link to those immutable resources instead of copying a whole provider runtime.

Slang history belongs to one exact command-buffer generation. An abandoned or unsubmitted predecessor gets separate state, and its resources are kept through a late submission or destruction. Preparing a replacement happens outside the renderer's encode call.

- Small uniform blocks use immutable Metal uploads for each encoder. Larger blocks use a prepared arena whose slots are released on completion.
- The exact capacity of a chain decides whether it can accept work, including several phases in one command buffer. When capacity runs out, it returns busy without a CPU wait.
- Command buffers that the caller retains keep the provider's temporary texture views alive, and the ordinary presenter keeps showing coherent processed output during that time.
- Generated deliveries encode their later stages in separate presentation command buffers.

RGBA8 Slang frames use BGRA8 working textures and GPU texel transfers back to the original target format. A 1:1 nearest transfer also accepts outputs that can only be render targets, without changing their usage or dimensions. Float16 and float32 sources keep floating-point working images. Color normalization does not change the selected upscaler or the method it reports.

### Sandbox access

Sandboxed consumers of shared effects receive read access to the prepared resources and selected models. Original shader folders, unrelated application data and other games' writable data stay outside those grants. Native mpv reads its selected original shader paths through the player's own file access, while the shared prepared snapshots have their own resource scope. Live model locations receive exact read grants without creating model stores, and a provider that could be selected later but is missing is left out while the valid live control binding stays available. A graphics attachment that cannot be isolated leaves the game's original rendering in place. Required runtime isolation and explicit cancellation keep their normal errors.

## Managed collections

Managed collections are the shader collections installed on request from Runtimes → Effects → **Shaders**, as opposed to the effects included with the app. Their FX collections keep their declared include and texture search directories inside their verified installation folders, which are not modified after installation. CShade, prod80, FXShaders, qUINT, NiceGuy shaders, Visibility bitmask lighting, AstrayFX and OtisFX use the same installation, reservation while in use, import, search and live updates as the other formats, and NiceGuy shaders and OtisFX also keep their declared texture directory. A collection whose catalog entry declares no source recipe or added notice, such as AstrayFX, OtisFX, prod80 or qUINT, keeps its selected files exactly as published: each file matches its Git blob at the selected commit and is read-only, and nothing is added to or rewritten in the collection. The two Visibility bitmask lighting (SSRT3) entry points read the renderer's actual depth, normals, radiance and camera matrices, and follow the same missing-input rule as other shaders that use scene inputs. The libretro Slang collection installs its selected preset trees with their shared includes and notices.

A collection shader keeps the name its collection's catalog declares. Other collection shaders are named after their files, without directories, unless two files share a name; the shortest directory path that tells them apart is then kept. Graphics menus list them under the collection's name, which ends in "collection" and so stays distinct from included shaders taken from the same project.

## Shader output sizing

A prepared shader's output contract keeps resource allocation separate from resizing. `sizing` and `extentEditable` describe the target, and `resizeDirections` holds `"downsample"`, `"upscale"`, both or neither. A provider that accepts different target dimensions does not turn every color or screen filter into a resampling algorithm. The inspector and the library use the same output contract for included, collection, imported and custom shaders, and every row type uses the same shader execution path.

### Geometry and row type

One geometry classifier reads each shader's declared output before execution and derives its editor type. [Shader placement](PIPELINE.md#shader-placement) lists the geometry kinds. The rules are:

- Same-size and unknown geometry is an Image filter, and so is a fixed 1× output. A same-size filter stays an Image filter when an output size is chosen; the size is a separate fit after the shader.
- A fixed pixel size is a Downsample, like a fixed-resolution row.
- Fixed and conditional scales are an Upscale or a Downsample according to their declared direction. Conditional outputs keep their known scale range, and variable outputs keep their authored geometry rule.
- A requested-size shader takes the direction of its row's size. Input-relative factors below 1, window fractions below 1 and fixed pixel sizes are Downsample; larger factors and window fits are Upscale; without a size, the shader keeps its default type. Menus list it under that default type and, when it declares resize directions, under each of them. A shader that declares both directions is also an Image filter, placed at its input size.

Purpose tags, collection membership and filenames never assign output geometry, menu membership or default size, so an imported copy of a collection shader is placed exactly like the original. Explicit custom placement can use a requested-size or unknown shader when its provider accepts that size, no known size contract contradicts it, and the slot's default size gives that type. The placement then saves that size, so the row is shown where it was placed.

### Reading declared geometry

Published full-image geometry supplies the scale and direction when they are known. An mpv hook sized from a saved texture that follows the output inherits that texture's proven direction, and whole-number `WIDTH` and `HEIGHT` declare a fixed pixel size. Private feature targets and chroma-only reconstruction do not resize the RGB image.

### Resize declarations

A source that renders at a requested size can declare its resizing contract in an ordinary comment:

```glsl
// @OUTPUT_RESIZE both
```

The values are `none`, `downsample`, `upscale` and `both`. The declaration is independent of the filename, collection and descriptive tags. It cannot override an authored fixed scale or add target sizing to a provider that lacks it. The language's own rules still apply, so a standalone Slang shader keeps `#version` before this comment. Preparation keeps the declaration even when the provider rewrites its entry source, and checks it against the prepared geometry. Where a provider fits a same-size shader's result afterward, the declaration describes the sizing of that combined target, not an intrinsic shader canvas.

### Hook groups

Consecutive compatible RGB hooks that resize a working image and use its original `NATIVE` or `PREKERNEL` reference can share one libplacebo render. Saved references keep their original meaning within that group. Plane conversion, incompatible color policies, hook ordering and conflicting intermediate targets end a group. A standalone hook receives its own row input as its native reference. A group's resolution report describes the provider's input and final output; it does not measure each hook's private intermediate image.

## Named scene inputs

An authored shader binds actual renderer attachments with a declaration such as `//! SCENE_INPUT sceneNormal normal`. The first name is the shader resource, and the second is a role from the shared [input registry](../../src/modules/shared/effects/operation-contracts.mjs). Ordinary image filters need no declarations. A declared guide must match the current frame, view, region, color and resource lifetime, and a missing guide leaves only the processing that depends on it pending. A resource's name never implies a guide role.

| Provider | Named input types |
| --- | --- |
| ReShadeFX, MagpieFX and Slang | Read-only scene images and the actual view and projection matrices. The reflected matrix layout and stride stay explicit. |
| ISF | Additional declared image inputs. Matrices are not an ISF input type. |
| libplacebo hooks | Named read-only `BIND` textures, with their real dimensions and `WHEN` expressions. Original `SAVE` and static textures keep their names and lifetimes. |

The registry includes depth, motion, exposure, normal, roughness, material reflectance, resolved and noisy lighting, hit distance, masks and the exact pair of images with and without the HUD. Each provider exposes only the types its format supports. An authored binding cannot overwrite a reserved source, a static texture or a saved resource. Managed collections and imported files use the same bindings, requirements and execution path.

Named radiance inputs use their actual linear primaries, reference white and pre-exposure, and the shared GPU conversion brings known units into the shader's linear working domain. Material reflectance receives the gamut conversion without exposure or reference-white scaling, and auxiliary alpha stays data. When the units are unknown, the dependent row stays pending while compatible image processing continues. These conversions use prepared resources and do not advance the source timeline or shader history.

### Scene history

ReShadeFX entries that accumulate renderer data can declare `//! SCENE_HISTORY real`. Their persistent images and animation state advance only after a real source frame completes successfully. Redraws and generated images reuse the matching real frame's state without advancing it. The source epoch, a reset, changed upstream content and the row's identity decide when the history is invalidated. Unsubmitted work keeps separate resources, so a late command buffer cannot replace newer history. The declaration requires the FX provider's `sceneHistoryAPI`. It does not detect scene cuts or create missing motion data.

## Shader analysis

A central shader resolver accepts included, registered local and collection shaders. Parsed mpv `HOOK` and `BIND` dependencies decide `requiresVideoPlanes`, `inputPlanes` and whether the shader works on RGB; a filename or neural description never makes a shader compatible with RGB game frames.

Fixed size expressions proportional to the input can provide `outputScale`. Pixel constants, conditional resizing, sizes that depend on the display and geometry left unresolved across hooks are never turned into guessed factors. Instead, a prepared shader row carries `outputExtent: "presentation"` when the original renderer must own those sizes, so its `WHEN` and `OUTPUT` expressions use the actual final size. These prepared fields are separate from the editable saved plan.

Shader traits are versioned by their parser. They are refreshed from local source reads of limited size and memoized, without rewriting installed pack metadata during status reads. Analyses also persist in `graphics/shader-traits-cache.json` in the launcher's user data directory. Each entry is keyed by the parser's identity (a digest of the trait parser's source files) and the shader file's identity (its filesystem identity, size, and modification and change times, together with those of its dependencies). A later launcher process reuses an entry only when both match, so a changed parser or file is analyzed again. The store is written atomically after a short delay and holds at most 8192 entries.

In Simple, imported upscalers use an automatic ordered plan, and the saved editor mode does not change. Replacing an imported source clears only the parameters of the rows that select it.

### Derived planes

Luma and chroma derived from RGB work on game images and video images through the same libplacebo adapter. GPU passes derive the requested planes from the supplied RGB image and its color description, and connect compatible hook groups without CPU readback. Original decoder planes also carry native subsampling, chroma placement and decoder metadata. A hook that needs those original inputs keeps that requirement and never receives an invented decoder plane.

## Native video prefixes

The video module runs a compatible leading run of shaders inside mpv, the native prefix, against the decoded source phases. [mpv shaders](../game-types/VIDEO.md#mpv-shaders) describes this from the player's side, and [native prefix routing](INPUTS_AND_ADAPTERS.md#native-prefix-routing) describes the module hook that removes the prefix from the shared entry.

Native mpv shader prefixes keep their declared source and scaling phases. The module passes the original source paths with mpv's single-file shader option and scalar parameter values with its append option, and shared processing receives the rest of the plan. A later RGB hook stays in the shared chain. This split never moves Advanced output-size rows across shader or neural rows. A native shader row is removed only from the temporary shared entry, so it is not processed twice, and its saved settings stay unchanged. Saving or applying a preset keeps the full sequence, including the native prefix.

A shader row that cannot run in this arrangement, such as one with a missing file or invalid parameters, or a video-plane shader after shared RGB rows, is bypassed with its reason, at launch and in a running player alike. The other rows keep running, and the graphics status lists the row as `bypassed`. A video-plane shader after shared processing is reported as an ordering error before playback, and the selected sequence stays as saved.

### Player scaling

mpv scales the video itself with `libplacebo:ewa_lanczossharp`, set through its `scale`, `cscale` and `dscale` options, when its registry provides that filter, and with bilinear otherwise. With **Graphics** off, the player still applies basic bilinear resizing. A v0.4.0 video record stored its mpv filter as a Simple scaling selection, and the one-time upgrade leaves that selection with mpv's own scaler without adding a row. A shared scaling method such as MetalFX is always a graph row.

During an explicit installation, the mpv manager records `installationMetadata.scaleFilters` from the selected executable's scaler registry. Installation still succeeds when the registry cannot be inspected. The mpv 0.41.0 archive that the manager installs has a matching registry fallback keyed by version and checksum, and other installations without metadata keep the minimum standard filters. Status and ordinary selection read these records without launching mpv. The player's registry is separate from the shared libplacebo provider's registry and platform requirements.

### Coordinated updates

Live mpv options are validated against the player and an actual renderer update. Restoring the previous native options uses the same validation. Errors from the rejected candidate do not count as a successful restoration, and a failed restoration is reported separately. Shared rows use the ordinary checked [live publication](LIVE_UPDATES.md#atomic-publication).

When native and shared settings change together, a processor that advertises `presentationHoldAPI: 1` can keep an existing visible opaque SDR overlay on screen until the new matching output is displayed. The hold stays active while either side is being restored after a failure, and an explicit finish resumes continuous playback. This covers transitions that keep owned presentation. Other mixed transitions keep the accepted settings, and independent native or shared changes use their ordinary live paths.

`presentationHoldAbandonAPI: 1` adds recovery from a final failure. After both rendering contracts and the original pause state are restored, an `abandon` command releases the failed cover to the original rendering. Its matching `abandoned` response has `holding: false` and `presentedTime: 0`; it does not acknowledge a displayed frame and receives no `finish` command. When restoration fails, the cover stays. A later transaction waits for the matching abandonment acknowledgment before it replaces its mailbox.

Held Simple output records the shader selection, placement and accepted controls that were actually encoded. A replacement that keeps the previous shader as a fallback does not acknowledge the rejected selection. Transaction boundaries refresh the validated inputs once on the player's reader, and synchronous encoding keeps those inputs stable through shader uniforms and final frame identification.

## Model storage and import

A runtime manager, `graphics-neural-models`, imports compatible `.dlssmodel`, `.vsrmodel`, `.srmodel`, `.fgmodel` and `.restorationmodel` packages into content-addressed application storage. [Neural models and packages](NEURAL_RESTORATION.md) describes the package formats and the original formats that import converts.

`neural/model-sources` also recognizes compatible packages under an application's `Contents/Resources/models`, in a ZIP that contains that layout, or in a standalone package ZIP. Recognition validates manifest metadata of limited size and the declared file sizes, without hashing weights. ZIP import streams only the selected manifests, declared weights and notices, with limits on their actual expanded size. The application and unrelated resources are never extracted or executed.

Import keeps the source filename or package attribution and the notices beside the model, verifies the weights' checksums and leaves the source unchanged. Compatible raw safetensors are checked against the selected operation's exact tensor contract, and the importer builds and validates their model package. DLSS SR capture import, described in [DLSS SR captures](NEURAL_RESTORATION.md#dlss-sr-captures), accepts the original library file or its capture folder. It translates the library's PTX reconstruction shader into a Metal kernel for the `.srmodel` package and runs no CUDA or Python code.

Preparation and live edits hash an installed model's weights and companion files once per file identity. A file that has been rewritten, replaced or touched is hashed again before use, and Lossless Scaling model copies follow the same rule. Runtime leases, reservations held while a model is in use, keep models available while a game or processing child uses them.

## Video preview and export

The video module exposes `previewVideo(entry, payload, context)` and `exportVideo(entry, payload, context)` through its ordinary action metadata. Preview uses the normal native player launch with the saved entry, and export uses the saved graphics plan without creating a separate editor copy. [Preview and export](../game-types/VIDEO.md#preview-and-export) describes both actions and the supported export formats.

The export's fixed output size supplies the presentation dimensions used by Auto and `presentationScale`, while factors of preceding stages and explicit pixel dimensions remain independent stage controls. The inspector opens the size and output dialogs, and a programmatic export payload can supply `width` and `height`. A successful result includes `output`, the actual dimensions and the helper's codec and HDR metadata when supplied. Progress and cancellation use the normal module-action context. Progress notifications are best effort, so failures of an observer or warning sink do not interrupt encoding, while invalid helper messages remain errors.

The offline helpers exclude inherited game injection and live graphics control variables. Selected models, effects plans and output settings are passed to each processing job explicitly. Automatic model choices use the same operation-aware preferences as playback. The export snapshot resolves and reserves the selected package through preparation and its own helper process, and keeps the game's saved Automatic selection. A missing requested model is reported before the file job starts.

Compatible image shaders, spatial filters and neural rows run in their saved order. Frame generation from image pairs uses the selected processor's paired-frame video API and the methods it declares. Renderer scene-temporal methods need guides that a decoder does not supply. Native decoder-plane hooks need the mpv preview, while shared derived-plane hooks work on decoded RGB. Each provider keeps its own architecture and platform requirements, and mpv playback and AVFoundation export each keep their own decoder support.

### Video frame interface

`native/video-frame.h` declares the synchronous C interface that the export helper uses: `rsVideoCreate`, `rsVideoProcess` and `rsVideoRelease`. A version 1 `RSVideoFrame` supplies the caller's SDR BGRA8 Metal source and output textures, a frame ID, the source timeline time in milliseconds and the frame duration. One handle uses one command queue and the prepared ordered plan. Processing submits each frame's complete chain, including neural completion, and waits for it before returning. This file-processing interface is separate from asynchronous native window presentation.

- `rsVideoProcessColor` adds explicit source and target color descriptions for RGB8 and RGB16F processing.
- `rsVideoProcessSequence` returns the ordered generated phases and the current real endpoint, with their positions between the previous and current source PTS. A null output array queries the capacity without advancing history. GPU completion and asynchronous model errors are resolved before success returns.

When processing is inactive and the source and output have the same size, pixel format and color description, the frame is copied exactly on the GPU. Requested resizing or color conversion follows its declared output contract.

### Export status

`rsVideoGetOutputColorStatus` reads the requested and actual final tone-mapping operation and a nonfatal fallback reason. Its versioned status struct is metadata only and leaves the processing ABI unchanged. Helper progress and completion messages keep `outputColor`, and the ordinary export result reports the actual mapping with its reason.

`rsVideoGetQualityStatus` reads optional [adaptive processing](EFFECT_PLANS.md#adaptive-processing-size) metadata without waiting for preparation or GPU work. Its version 1 `RSVideoQualityStatus` holds the target row, the state (pending, active or off), the processing scale, the smoothed GPU duration, the measured scope and a reason. The function returns 1 for a requested policy, 0 when none is requested and -1 for an invalid request. Helper progress and completion messages keep the same metadata. Adaptive processing changes only the selected intermediate size, and final frame dimensions and timestamps follow the export settings. `RS_VIDEO_QUALITY_EXTERNAL_PROCESSING` identifies matching render intervals of affected external work. This scope needs timing from each affected external operation, not the duration of a caller's copy or synchronization wait.

### Neural-only processing

An older action, `processVideo`, is kept for compatibility and has a separate contract for neural-only processing. It requires macOS 26 or later and an input that AVFoundation can read, while the graphics export helper follows its selected package's [macOS requirement](../runtimes/SYSTEM_REQUIREMENTS.md#graphics). It writes to a separate MP4 destination, using the intensity and temporal values of the selected Advanced neural row when present, or else the enabled Simple neural selection.

`reshade/neural/offline.processVideo(options)` takes `input`, a new `output`, `modelPath`, optional cancellation and progress callbacks, and an optional graphics runtime `root`. `userDataDir` turns on lifetime tracking for installed models, and `onToolProcessSpawn` attaches the processing child to the launcher's lifecycle management. Its defaults are `intensity: 1`, `temporal: true`, `processingScale: 1`, `detailStrength: 1`, `colourStrength: 1` and `codec: "h264"`. MP4, MOV and M4V output are supported, and ProRes requires MOV. Export leaves source files unchanged, refuses to overwrite files and keeps the source audio. Offline output uses SDR 8-bit frames, independent of the window capture or presentation dimensions.

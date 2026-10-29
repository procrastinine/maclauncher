# Shader, model and media integration

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

Shader formats and neural models plug into the shared graph. Native decoder phases and file export retain their own data and timing contracts.

[Provider interface and prepared resource scope](#provider-interface-and-prepared-resource-scope) · [Shader output sizing](#shader-output-sizing) · [Named scene inputs](#named-scene-inputs) · [Shader selection, derived planes and native video prefixes](#shader-selection-derived-planes-and-native-video-prefixes) · [Module prefix routing and coordinated media updates](#module-prefix-routing-and-coordinated-media-updates) · [Neural image settings and execution](#neural-image-settings-and-execution) · [Model import and offline video APIs](#model-import-and-offline-video-apis)

## Provider interface and prepared resource scope

Shader providers share the `ShaderNode` interface: an explicit selection,
per-node parameters and an `encode` call using the caller's command buffer and
textures. Providers own their compiled resources and histories. The shared
executor owns row order and intermediate targets; the presenter owns submission
and display timing. GPU resources remain alive until their submitted reads
retire, including after a row is replaced or removed.
Host-written model uniforms are copied into each encoded dispatch, preserving
their values when later phases share the same command buffer. LSFG phases reuse
temporary images within their serialized graph while retaining separate
generated outputs and temporal history per encoder.
An ordered execution holds at most four intermediate scratch sets. Exhausted
capacity returns busy; completion or abandonment releases the exact set even
when the caller retains a completed command buffer.
A ReShade FX chain reads its input in place when the input has the chain's
working size and format and allows shader reads and pixel-format views;
otherwise it copies the input into its first working image. A back-buffer pass
starts from a copy of the current image only when it can leave pixels
unwritten: blending, a partial write mask, stencil, a partial viewport,
`discard`, or a vertex shader other than the global `PostProcessVS` triangle.
The last full-screen pass of an unscaled chain renders into the output when the
output is a single-sample, single-level 2D render target in the working format.
The final FX row of an ordered graph renders into the graph's output under the
same conditions, so no final copy follows it.
FSR1 scratch images come from one pool per Metal device, keyed by size and
format, shared by every FSR1 encoder and charged to a 256 MiB process budget,
about four 3840×2160 images. A replacement graph at the same output size reuses
the idle images of the graph it replaces. An idle image is released once no
live encoder's latest output uses its size and format, so a resize, a drawable
change or a retired graph keeps no stale image charged. When the budget is
full, idle images of another encoder's size are released before a request is
refused.
Explicit diagnostic frame capture uses the game's private effects directory and
performs readback only for requested frames. Ordinary processing and intermediate
effect passes do not require image readback.

Prepared shader nodes may declare
`inputPolicy: "source" | "srgb-sdr" | "linear-source"`.
The shared executor owns the selected conversion, including source primaries,
transfer, alpha and whether the image was already display mapped. This policy
participates in resource/history identity. Legacy ReShadeFX compilation uses an
eight-bit display-backbuffer contract and selects `srgb-sdr`; an explicitly
HDR-aware FX entry may opt into source values with a `//!INPUT_POLICY source`
comment. A conflicting or invalid declaration rejects the candidate. The source
policy retains the supplied image encoding; it does not invent missing metadata.
The `linear-source` policy decodes the supplied transfer function while retaining
source primaries, reference white and signed floating-point values. The executor
returns the result to the source encoding and alpha convention after the row.
It uses the same prepared conversion boundary as other shader policies and
requires the payload's `linearInputPolicyAPI`. An authored entry selects it with
`//!INPUT_POLICY linear-source`; it stays in the shared graph when a native video
prefix cannot provide that conversion.
Shader-authored alpha remains part of its output, while neural model adapters
retain their separate source-alpha transport.

Managed FX collections retain declared include and texture search directories
inside their verified immutable roots. CShade, prod80, FXShaders, qUINT, NiceGuy
shaders and Visibility bitmask lighting use the same installation, leases,
import/search and live publication as the other formats. NiceGuy shaders also
retain their declared texture directory. Visibility bitmask lighting (SSRT3)
exposes two entry points, lighting only and diffuse composition. Both read actual
renderer depth, normals, radiance and camera matrices, and follow the same
missing-input rule as other scene-input shaders. The libretro Slang collection
installs its selected preset trees with their shared includes and notices.

A collection shader keeps the name its collection catalog declares. Other
collection shaders are named after their files without directories, unless two
files share a name; the shortest distinguishing directory path then remains.
Graphics menus list them under the collection's name, which ends in
"collection" and so stays distinct from included shaders taken from the same
project.

Slang and libplacebo preparation uses a checksummed resource inventory and a
content-addressed cache under `userData/graphics/shaders/`. Per-game selections
link those immutable resources rather than copying an entire provider runtime.
Slang history belongs to an exact command-buffer generation. An abandoned or
unsubmitted predecessor receives separate state, with its resources retained
through late submission or destruction. Replacement preparation runs outside the
producer's encode call. Small uniform blocks use immutable per-encoder Metal
uploads; larger blocks use a prepared arena with completion-owned slots. Exact
chain capacity determines admission, including multiple phases in one command
buffer. Exhausted capacity returns busy without a CPU wait.
Retaining command buffers preserve the provider's temporary texture views.
The ordinary presenter keeps coherent processed output during that interval.
Generated deliveries encode their suffix in separate presentation command buffers.
RGBA8 Slang frames use BGRA8 working textures and GPU texel transfers back to the
original target format. A 1:1 nearest transfer also accepts render-target-only
outputs without changing their usage or dimensions. Float16 and float32 source
paths retain their floating-point working images. Colour normalization does not
change the selected upscaler or its reported method.
For sandboxed shared effect consumers, prepared resources and selected models
receive read access. Original shader folders, unrelated application data and
another game's writable data stay outside those resource grants. Native mpv
reads its selected original shader paths through the original player's file
access; shared prepared snapshots have their separate resource scope.
Live model locations receive exact owned read grants without creating model
stores. Missing prospective providers are omitted while the valid live control
binding remains available. A graphics attachment that cannot be isolated uses
the game's original rendering; required runtime isolation and explicit
cancellation retain their normal errors.

## Shader output sizing

Prepared output contracts separate resource allocation from resizing:
`sizing` and `extentEditable` describe the target, while `resizeDirections`
contains `"downsample"`, `"upscale"`, both, or neither. A provider accepting
different target dimensions does not make every color or screen filter a
resampling algorithm. The inspector and library use the same output contract
for included, managed, imported and custom sources. One geometry classifier
derives each shader's editor type from that contract, as described in
[Effect plans](EFFECT_PLANS.md): proven same-size, fixed-size and unknown
geometry is an Image filter; fixed and conditional scales follow their declared
direction; requested-size output follows the row's size. Every type uses the
same shader execution path.

Published full-image geometry supplies the scale and direction when known. An
mpv hook sized from a saved texture that follows the output inherits that
texture's proven direction, and whole-number `WIDTH`/`HEIGHT` declare a fixed
pixel size.
Private feature targets and chroma-only reconstruction do not resize the RGB
image. A fixed 1× output remains an Image filter. Conditional outputs retain
their known scale range; variable outputs retain their authored geometry rule.
Explicit custom placement remains available when the provider accepts the
requested target and no known size contract contradicts it.

Processing dimensions retain the producer's logical output mapping. A
nonuniform sampling grid still fits that mapped window or fullscreen target;
its pixel dimensions alone do not declare another display aspect or crop.

A target-sized source can declare its resizing contract in an ordinary comment:

```glsl
// @OUTPUT_RESIZE both
```

The values are `none`, `downsample`, `upscale` and `both`. The declaration is
independent of the filename, collection and descriptive tags. It cannot override
an authored fixed scale or add target sizing to a provider that lacks it.
Original language rules still apply; a standalone Slang shader keeps `#version`
before this comment. Preparation retains the declaration even when the provider
rewrites its entry source and checks it against the prepared geometry. Where a
provider fits a same-size shader result afterward, the declaration describes
that composite target sizing rather than an intrinsic shader canvas.

Contiguous compatible RGB hooks that resize a working image and consume its
original `NATIVE` or `PREKERNEL` reference can share one libplacebo render. Saved
references retain their original meaning within that group. Plane conversion,
incompatible color policies, hook ordering and conflicting intermediate targets
remain group boundaries. A standalone hook receives its own row input as its
native reference. Group resolution reports describe the provider's input and
final output; they do not measure each hook's private intermediate image.

## Named scene inputs

Authored shaders bind actual renderer attachments with a declaration such as
`//! SCENE_INPUT sceneNormal normal`. The first name is the shader resource; the
second is a role from the shared
[input registry](../../src/modules/shared/effects/operation-contracts.mjs).
Declarations are optional for ordinary image filters. A declared guide must match
the current frame, view, region, color and resource lifetime; missing guides leave
only dependent processing pending. Resource names never imply a guide role.

| Provider | Named input types |
| --- | --- |
| ReShadeFX, MagpieFX and Slang | Read-only scene images and actual view/projection matrices. Reflected matrix layout and stride remain explicit. |
| ISF | Additional declared image inputs. Matrices are not an ISF input type. |
| libplacebo hooks | Named read-only `BIND` textures, including their real dimensions and `WHEN` expressions. Original `SAVE` and static textures retain their names and lifetimes. |

The registry includes depth, motion, exposure, normal, roughness, material
reflectance, resolved and noisy lighting, hit distance, masks and the exact
HUD-less/UI pair. Providers expose only the types their format supports. An
authored binding cannot overwrite a reserved source, static texture or saved
resource. Managed collections and imported files use the same bindings,
requirements and execution path.

Named radiance inputs use their actual linear primaries, reference white and
pre-exposure. The shared GPU conversion brings known units into an authored
linear working domain. Material reflectance receives the gamut conversion
without exposure or reference-white scaling; auxiliary alpha stays data.
Unknown units leave the dependent row pending while compatible image processing
continues. These conversions use prepared resources and do not advance the
source timeline or shader history.

ReShadeFX entries that accumulate renderer data may declare
`//! SCENE_HISTORY real`. Their persistent images and animation state advance
only after a real source frame completes successfully. Redraws and generated
images reuse the corresponding real-frame state without advancing it. Source
epoch, reset, changed upstream content and row identity govern invalidation.
Unsubmitted work retains independent resources so a late command buffer cannot
replace newer history. The declaration requires the FX provider's
`sceneHistoryAPI`; it does not infer scene cuts or create missing motion data.

## Shader selection, derived planes and native video prefixes

The central shader resolver accepts included, registered local and managed
shader identities. Parsed mpv `HOOK` and `BIND` dependencies determine
`requiresVideoPlanes`, `inputPlanes` and RGB compatibility. A filename or neural
description does not make a shader compatible with RGB game frames. Fixed
input-proportional size expressions may provide `outputScale`; pixel constants,
conditional resizing, display-dependent sizes and unresolved cross-hook geometry
are not converted into guessed factors. Prepared shader rows instead carry
`outputExtent: "presentation"` when the original renderer must own those sizes,
so its `WHEN` and `OUTPUT` expressions use the actual final extent. These prepared
fields are separate from the editable saved plan. Parser-versioned traits
refresh from bounded local source reads and are memoized without rewriting
installed pack metadata during status reads. Analyses also persist in
`graphics/shader-traits-cache.json` under the launcher's user data directory,
keyed by the parser identity (a digest of the trait parser's source files) and
the shader file's identity (filesystem identity, size and modification and
change times, with those of its dependencies). A later launcher process reuses
an entry only when both match; a changed parser or file is analyzed again. The
store is written atomically after a short delay and holds at most 8192 entries. Simple imported upscalers use an
automatic ordered plan without changing the saved editor mode.

RGB-derived luma/chroma processing applies to game images and video images
through the same libplacebo adapter. GPU passes derive the requested planes
from the supplied RGB/color contract and connect compatible hook groups without
CPU readback. Original decoder planes additionally carry native subsampling,
chroma placement and decoder metadata. A hook requiring those original inputs
keeps that requirement rather than receiving an invented decoder plane.

Simple `graphics.spatialShader` stores the existing shader-settings shape or
`null`. It is mutually exclusive with a selected native `spatialMethod`, while
the appearance selection in `reshade` remains independent. Conversion produces
an ordinary shader row at the spatial stage after reconstruction and before
frame generation. Intrinsic shader dimensions remain intact; an automatic
spatial fit follows when needed. The source-resolution request remains separate
and follows the same native, virtual and completed-frame fallback policy as
other spatial methods. No provider or virtual window is selected from a neural
description alone.

Replacing an imported source clears only the parameters of the rows that
select it.

Turning neural reconstruction off cancels pending preparation for that game.
Other queued effects retain their settings, and the accepted pipeline remains
active until its replacement is ready. Separately started model downloads
remain available in Runtimes. Candidate resource acquisition can stop waiting
without retiring an active writer or a model already used by the game; an
unbound lease acquired later is released by its exact token.

Native mpv shader prefixes retain their declared source and scaling phases.
The module passes original source paths with mpv's single-file shader option,
and scalar parameter values with its append option. Shared processing receives
the remaining plan. Advanced output-size rows are not moved across shader or
neural rows by this transformation. A native shader row is removed only from
the transient shared entry so it is not processed twice; its saved settings
remain unchanged. A shader row that cannot run in this arrangement (a missing
file, invalid parameters, or a video-plane shader after shared RGB rows) is
bypassed with its reason, at launch and in a running player alike; the other
rows keep running and the graphics status lists it as `bypassed`.

The original player scales with `libplacebo:ewa_lanczossharp` through mpv's
`scale`, `cscale` and `dscale` when its registry provides that filter, and with
bilinear otherwise. Graphics Off keeps basic bilinear resizing by the original
player. A v0.4.0 video record stored its mpv filter as a Simple scaling
selection; the one-time upgrade leaves that selection with mpv's own scaler
and adds no graph row. A shared scaling method such as MetalFX remains a graph
row.

The mpv manager records `installationMetadata.scaleFilters` from the selected
executable's scaler registry during explicit installation. Failure to inspect
that registry does not prevent installation. The pinned 0.41.0 archive has a
matching version-and-checksum registry fallback; other installations without
metadata retain the minimum standard filters. Status and ordinary selection
read these records without launching mpv or making network requests. The
original player's registry is distinct from the shared libplacebo provider's
registry and platform requirements.

## Module prefix routing and coordinated media updates

An optional asynchronous `prepareEffectsEntry(entry, context)` hook returns the
entry used by shared processing. It preserves the supplied entry and removes
only work performed by the original renderer. The launcher exposes this hook
to effect preparation through `options.prepareEffectsEntry` and uses
`context.effectsEntry` for the equivalent launch-time selection. Main-process
validation, live controls and shared plan preparation operate on the resulting
runtime entry; the saved game retains its complete canonical settings and
Advanced plan. Runtime-specific routing remains in the module.

The video module uses this contract for original mpv hooks and Simple native
scaling. Compatible shader prefixes execute against decoded source phases;
the shared plan starts with the remaining rows. A later RGB hook stays in the
shared chain. A video-plane hook after shared processing reports an ordering
error before playback, preserving the selected sequence.
Saving or applying a preset retains the full sequence, including the native
prefix. Live mpv options are validated against the player and an actual renderer
update. Restoring previous native options uses the same renderer validation;
errors from the rejected candidate do not acknowledge restoration. A failed
restoration is reported separately. Shared rows use the guarded graphics publication.
When both change together, a processor advertising `presentationHoldAPI: 1`
can retain an existing visible opaque SDR overlay until the new matching output
is displayed. The hold remains active while either side is restored on failure;
an explicit finish resumes continuous playback. This API covers transitions
that retain owned presentation. Other mixed transitions retain the accepted
settings; independent native or shared changes use their ordinary live paths.
`presentationHoldAbandonAPI: 1` adds terminal-failure recovery. After both
rendering contracts and the original pause state are restored, an `abandon`
command releases the failed cover to original rendering. Its matching
`abandoned` response has `holding: false` and `presentedTime: 0`; it is not a
displayed-frame acknowledgment and receives no `finish` command. Restoration
failure preserves the cover. A later transaction waits for the matching
abandonment acknowledgment before replacing its mailbox.
Held Simple output records the shader selection, placement and accepted controls
actually encoded. A replacement that keeps the previous shader as a fallback
does not acknowledge the rejected selection. Transaction boundaries refresh
validated inputs once on the producer reader; synchronous encoding keeps those
inputs stable through shader uniforms and final frame identification.

## Neural image settings and execution

A neural reconstruction row has the following saved shape:

```js
{ id: "reconstruct", kind: "neural", method: "mlx-dlss", enabled: true,
  settings: { modelPath: "/models/reconstruction.dlssmodel", temporal: false, intensity: 1 } }
```

`modelPath` selects a local model package. `intensity` is a finite value from
0 to 1, with 1 using full model output. Lower values blend reconstruction with
the input. The default is single-frame processing, with `temporal: false`.
Temporal mode estimates bidirectional optical flow from captured color frames
and retains provider-owned history. New streams, nonmonotonic source identity
or time, and input-size changes reset that history. Skipped renderer submissions
do not restart the sequence of successful model inferences.
Preparation validates the model package and installed provider before publishing
native resource paths. The portable provider requires ARM64 and macOS 14 or
later; it does not require an M5-specific DLSSMac binary.
The compute provider runs in ARM64. A translated x86_64 client uses the shared
ARM64 GPU service and IOSurface/event transport rather than loading ARM64 code
into the Intel process. The client keeps the same graph, model and image
contracts.

## Model import and offline video APIs

The video module exposes `previewVideo(entry, payload, context)` and
`exportVideo(entry, payload, context)` through its ordinary action metadata.
Preview uses the normal native player launch flow with the saved entry.
Export consumes the saved Simple configuration or Advanced sequence without
creating a separate editor copy. Its fixed output extent supplies the
presentation dimensions used by Auto and `presentationScale`; preceding-stage
factors and explicit pixel dimensions remain independent stage controls.
The inspector opens size and output dialogs; programmatic export payloads may
supply `width` and `height`. A successful result includes `output`, actual
dimensions and the helper's codec/HDR metadata when supplied. Progress and cancellation use the normal
module-action context. Progress notifications are best effort; observer or warning
sink failures do not interrupt encoding. Invalid helper messages remain errors.
The `processVideo` compatibility action retains the
separate neural-only processing contract described below.
Both offline helpers exclude inherited game injection and live graphics
control variables; selected models, effect plans and output settings are passed
explicitly for the processing job.
Automatic model choices use the same operation-aware preferences as playback.
The export snapshot resolves and leases the selected package through preparation
and its owned helper process; it preserves the game's saved Automatic selection.
A missing requested model is reported before starting the file job.

The graphics export helper requires macOS 14 or later and one
AVFoundation-decodable opaque video track. SDR output uses H.264 MP4 with AAC
audio; tagged PQ/HLG output uses float GPU processing and HEVC Main10 with its
color tags. Source timestamps and rotation/mirror metadata are retained.
Compatible image shaders, spatial filters and neural rows execute in saved
order. Image-pair frame generation uses the selected processor's paired-frame
video API and declared supported methods. Renderer scene-temporal methods need
guides that a decoder does not supply. Native decoder-plane hooks retain the
mpv Preview path; shared derived-plane hooks operate on decoded RGB. Each
provider keeps its own architecture and platform requirements. mpv playback and
AVFoundation export retain their respective decoder support.

`native/video-frame.h` declares the synchronous C interface used by the export
helper: `rsVideoCreate`, `rsVideoProcess` and `rsVideoRelease`. A version-1
`RSVideoFrame` supplies caller-owned SDR BGRA8 Metal source/output textures,
frame ID, source timeline time in milliseconds and frame duration. One handle
uses one command queue and the prepared ordered plan. Processing submits and
waits for that frame's complete chain, including neural completion, before
returning. This file-processing interface is separate from asynchronous native
window presentation. `rsVideoProcessColor` adds explicit source and target color
descriptions for RGB8/RGB16F processing. `rsVideoProcessSequence` returns ordered
generated phases and the current real endpoint, with their position between
the previous and current source PTS. A null output array queries capacity
without advancing history. GPU completion and asynchronous model errors are
resolved before success returns.

Inactive processing uses an exact GPU image transfer when source and output have
the same extent, pixel format and color description. Requested resizing or color
conversion follows its declared output contract.

`rsVideoGetOutputColorStatus` reads the requested and actual final tone-map
operation and a nonfatal fallback reason. Its versioned status struct is
metadata only and leaves the processing ABI unchanged. Helper progress and
completion messages preserve `outputColor`; the ordinary export result exposes
the actual mapping with its contextual reason.

`rsVideoGetQualityStatus` reads optional adaptive-processing metadata without
waiting for preparation or GPU work. Its version-1 `RSVideoQualityStatus` carries
the target row, pending/active/off state, processing scale, smoothed GPU duration,
measured scope and reason. A result of 1 describes a requested policy, 0 means
none is requested, and -1 indicates an invalid request. Helper progress and
completion messages retain the same metadata. Adaptive processing changes only
the selected intermediate extent; final frame dimensions and timestamps retain
the export contract. Off restores the canonical row extent.
`RS_VIDEO_QUALITY_EXTERNAL_PROCESSING` identifies matching affected external
render intervals. This scope requires timing from each affected external
operation, rather than the duration of a caller's copy or synchronization wait.

The `graphics-neural-models` manager imports compatible `.dlssmodel`, `.vsrmodel`,
`.srmodel`, `.fgmodel` and `.restorationmodel` packages into
content-addressed application storage. `neural/model-sources` also recognizes
compatible packages under an application's `Contents/Resources/models`, a ZIP
containing that layout, or a standalone package ZIP. Recognition validates
bounded manifest metadata and declared file sizes without hashing weights.
ZIP import streams only selected manifests, declared weights and notices with
actual expanded-byte limits. The application and unrelated resources are not
extracted or executed. Import retains source filename/package attribution and
notices beside the model, verifies weights checksums and preserves the source.
Preparation and live edits hash an installed model's weights and companions
once per file identity; a rewritten, replaced or touched file is hashed again
before use. Lossless Scaling model copies follow the same rule.
Compatible raw safetensors use the selected operation's exact tensor contract;
the importer constructs and validates its model package. Restoration imports
and the original RIFE-folder conversion are described in
[Neural restoration](../NEURAL_RESTORATION.md). Runtime leases keep models
available while a game or processing child uses them. Live compute uses ARM64
on macOS 14 or later, including service execution for translated clients. The separate neural-only
compatibility command requires macOS 26 or later and an AVFoundation-readable
input; the graphics export helper uses the macOS 14 interface described above.

DLSS SR capture import accepts the original `libnvidia-ngx-dlss.so.310.7.0`
beside `L0001_params.bin`, `L0012_params.bin` and their corresponding
`L0001_buf<address>.bin` / `L0012_buf<address>.bin` buffers. Selecting the library
or its capture folder uses the same managed model import. The adapter validates
the supported original identity, decodes tensor layouts and translates the
original reconstruction PTX into the typed `.srmodel` package. Import reads
these inputs as data; it executes neither the vendor library nor CUDA/Python.
The matching captured packed weights and filter remain required resources.

`reshade/neural/offline.processVideo(options)` takes `input`, a new `output`,
`modelPath`, optional cancellation and progress callbacks, and an optional
graphics runtime `root`. `userDataDir` enables managed-model lifetime tracking;
`onToolProcessSpawn` attaches the processing child to launcher lifecycle
management. Its default controls are intensity 1, temporal estimation enabled,
processing scale 1, detail strength 1, colour strength 1 and H.264 output.
MP4, MOV and M4V output are supported; ProRes requires MOV. Export preserves
source files, refuses overwrites and retains source audio. The `processVideo`
compatibility action uses a separate MP4 destination and the selected Advanced neural row's intensity and
temporal values when present, or the enabled Simple neural selection. Offline output uses SDR 8-bit frames rather than
the window capture or presentation dimensions.

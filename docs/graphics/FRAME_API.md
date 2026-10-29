# Frame, presentation and source-sizing APIs

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

Image handoff, scene guides, source allocation and output presentation are separate contracts. The same GPU execution path serves each compatible producer.

[Borrowed frames and owned presentation](#borrowed-frames-and-owned-presentation) · [Scene frames and matching guides](#scene-frames-and-matching-guides) · [Color, alpha and time domains](#color-alpha-and-time-domains) · [Geometry reuse and drawable lifetime](#geometry-reuse-and-drawable-lifetime) · [Game render allocation and processing extent](#game-render-allocation-and-processing-extent) · [Live source commands and virtual windows](#live-source-commands-and-virtual-windows)

## Borrowed frames and owned presentation

The color frame contract includes source and destination dimensions, device,
origin, color representation, frame identity and time. A consumer must not treat
an unrelated texture or a later command buffer as matching scene data.

`rsProcessFrame` encodes work into a borrowed Metal command buffer.
`rsProcessFrameWithDepth` adds a real matching depth texture. The caller owns
command-buffer submission and must retain the textures through GPU completion.
Encoding does not commit or wait for that borrowed command buffer.

Shader working resources belong to their source geometry, pixel format, Metal
device and producer queue. A device or queue change creates a replacement before
copying the next input. Already-encoded resources remain retained through their
actual command-buffer completion. Spatial scaler caches follow the same
queue/device boundary, including requests that only scale. Replacements preserve
the caller's source and presentation texture dimensions and pixel formats.

`rsCreateFramePresenter` and `rsSubmitFramePresenter` provide display-driven
presentation. The depth and explicit-timing variants retain their corresponding
input contracts. `rsDestroyFramePresenter` retires the presenter and its owned
work. A native Metal producer can register a layer through
`rsRegisterNativeMetalLayer`, use the matching source lease, and unregister it
before releasing its callback context. The headers in
`src/modules/shared/reshade/native/` define the versioned C structures.

Ordinary submission uses the caller's command buffer. A private Metal queue is
created only for detached neural work, paced frame generation or retained
replay. Unavailable frame-generation queues or display timing bypass generation
while retaining compatible processing on the caller's buffer. The failure is
retained for the unchanged selection; a subsequent accepted control or plan
change can retry. Stop retires display timing and owned work without releasing
images still in use by the GPU.

`rsSubmitFramePresenterObserved` adds display-driven retirement callbacks while
retaining ordinary frame generation. It requires the selected runtime's
`graphics.observedPresentationAPI: 1` capability or successful symbol lookup.
On successful submission, the observer context transfers until one final
real-display, drop, cancellation or GPU-error callback. Generated frames do not
retire the source observer. Producer-token release remains independent; a
positive presentation timestamp records actual real-frame display. Rejection
retains both contexts. ABI1 submissions can encode partial work before rejecting
a frame, so source storage remains valid through completion or discard of that
command buffer. The caller owns command-buffer submission. Explicit target-time
submission retains its strict timing contract and excludes frame generation.

Color, CRT, sharpening and spatial filtering process the submitted color image
and dimensions. Neural reconstruction adds its selected model, estimated flow
and provider-owned history. LSFG uses its selected model with opaque color images
and display-driven presentation. Its HDR path converts to linear BT.709/scRGB
with an 80-nit reference white and uses the original HDR generation kernel before
returning to the source encoding.

Scene-dependent processing has additional inputs:

- Depth shaders use matching scene depth alongside color.
- Renderer temporal upscaling uses matching depth, motion and jitter, plus the
  selected provider's camera data.

LSFG's own image-based motion estimation does not supply game motion vectors to
other effects. Neural estimated flow also remains private to its provider.
Renderer temporal inputs are accepted only through their renderer
integration or temporal frame API. Unsupported or mismatched inputs preserve
the original frame and report the processing reason.

## Scene frames and matching guides

The [temporal frame header](../../src/modules/shared/reshade/temporal/frame.h)
defines `RSTemporalFrame`: owner, borrowed commands, color/depth/motion/output
textures, actual render and output extents, independent texture offsets,
jitter, motion scale, pre-exposure, frame identity, timing and optional guides.
Motion maps current pixels to previous pixels after its declared scale. Flags
identify reversed/infinite depth, output-resolution or jittered motion and
actual perspective camera metadata. `rsProcessTemporalFrame` validates this
contract and dispatches the selected provider; it does not commit the caller's
command buffer.

`rsGetSceneFrameDemand(1)` exposes the enabled graph's required inputs without
preparing GPU resources. The plan reader derives them once per plan update;
the call reads them with one atomic load. Perspective near/far/FOV and actual view/projection
matrices are separate declarations. A producer can supply color, depth and
motion without a perspective camera description. `rsBindTemporalSceneMatrices`
copies actual transforms for the exact owner/frame/commands/texture tuple.
The texture-registration forms support producers recording before commands
exist; each frame boundary and producer retirement clears stale registrations.

`RSSceneMatrices` ABI 1 has a 152-byte layout. Matrices use row-major,
row-vector world-to-view and view-to-clip transforms. Separate flags declare
valid view/projection data, zero-to-one or minus-one-to-one clip depth, a projection
that already includes jitter, and downward NDC Y. Providers requiring projection
unprojection also require a known clip convention. Matrix orientation and jitter
representation belong to the producer boundary; a frame origin does not imply
them. A depth-only Image filter can require depth and projection without motion
or a separate perspective near/far/FOV declaration.

The shared `SceneGuideEncoder` normalizes consumed regions and known resize
geometry. Prepared node requirements select the needed depth, motion, masks
and exposure, including output-resolution motion conventions. Available
unconsumed guides are retained without GPU conversion.
Guide leases retain the actual transformed textures and camera metadata through
GPU completion, including suffix work on another command buffer. Generated
images and unknown coordinate warps do not supply replacement renderer guides.
The original guide coordinates remain separate from the current processing
image so a paused live edit can request another input. Current-image attachment
applicability is preserved independently; an upstream HUD pair cannot become
valid again merely because its source resources are retained.

`RSSceneAovs` in the
[AOV header](../../src/modules/shared/reshade/temporal/scene-aovs.h) is a versioned
companion to this frame. It carries real normal/roughness, material reflectance,
resolved or noisy lighting, hit distance, masks, metallic and HUD/UI attachments.
Each image declares its region, encoding, origin and capture pass. Frame/view,
epoch, image revision, pre-exposure and color metadata establish the exact tuple;
lit specular is distinct from material specular reflectance. Missing attachments
remain absent. An observed registration transfers one retirement callback until
all accepted GPU and replay use ends.

HUD-less color and UI color/alpha form an atomic pair with independent color
descriptions. Missing, stale or misaligned pairs preserve processing of the
complete composed image. The shared layer does not infer foreground or HUD masks.
MetalFX interpolation normalizes a complete aligned separate UI attachment's
declared color, alpha and origin on the GPU before using the SDK's separate-UI
mode. Unsupported separate regions or synchronization retain the complete
composed-image route.

`rsSetTemporalSceneCopyBoundary` registers an exact immutable scene snapshot and
engine target; the actual identity copy and ending blit encoder provide recording
authority. Unready optional work preserves the original copy and subsequent
renderer passes. Producer-specific capture belongs at the renderer boundary;
shader bindings and algorithms consume this common companion.

With `metal4SceneAPI: 1`, native MetalFX SDK spatial, temporal, denoised and
interpolation recordings can enter the same graph through the Metal4 recording
bridge. It observes the actual compiler-taking SDK factory, recording, queue and
commit options. Shared classic Metal work uses GPU events between the original
Metal4 segments; feedback retains the producer queue's ordering and affinity.
Unknown submission contracts preserve the original SDK recording. The borrowed
classic frame APIs above retain their existing command-buffer types.

An exact event-owned consumer can omit redundant original SDK GPU work after
successful replacement publication. Native history, direct window continuation
and later producer operations retain original work when their ownership requires
it. A pending drawable resumes on its existing recording worker after publication
and keeps producer order. Resource information does not create a new presentation
timeline or authorize an unprocessed frame between processed deliveries.

An SDK-generated midpoint carries synthetic provenance. Its closing real
endpoint's depth, motion and material images do not describe that midpoint.
Compatible image processing remains available; scene-dependent rows need matching
scene data, and another pair operation needs a complete pair and timeline. Exact
frame/view/epoch metadata and GPU-authorized target receipts keep the ordinary
presenter from applying the same prefix twice.

With `sceneWindowContinuationAPI: 1`, a cooperating producer can register the
native destination window for its exact scene tuple. The common presentation
path binds that window's authority, waits through a GPU producer event and
continues only the remaining graph against final composed color. The binding
identifies one final image; texture dimensions or window titles do not establish
ownership. Subviewports and ambiguous compositions need their own explicit
destination contract. HDR source declaration is independent of optional
perspective metadata.

Temporal provider ABI 1 keeps a separate history owner and a method bitmask.
An optional `rsPrepareTemporalResources` symbol builds resources without
encoding, consuming content IDs or advancing history. Existing providers
without that symbol retain the compatible disposable-preparation path.

## Color, alpha and time domains

`RSImageColorDescription` describes actual RGB primaries (BT.709, Display P3 or
BT.2020), transfer (sRGB, linear, PQ, HLG or camera BT.709), range, alpha,
reference white, luminance limits and scene/display reference. Explicit color
metadata accompanies `rsProcessFrameWithColor`, `rsProcessTemporalFrameColor`
and color-aware presenter/video entry points. The temporal ABI's legacy HDR
flag means linear BT.709 with 1.0 at 203 nits and nominal 1000-nit peak;
explicit metadata supplies the more specific contract.

The GPU color encoder handles transfer, gamut, range, exposure, alpha and output
quantization. A provider requiring bounded sRGB receives a local SDR conversion
island; unrelated graph rows retain their source description and precision.
Tone mapping into that island changes highlight information and does not make
an SDR model an HDR model. The final output conversion uses the actual target
color description and display headroom.

The FSR 2, FSR 3, FSR 4, ASR and SGSR2 temporal ABI 1 providers receive a local
linear BT.709, full-range, straight-alpha domain with a 203-nit reference white.
Where the provider consumes a supplied exposure texture, its scalar is multiplied
by `203 / sourceWhite` to compensate for the RGB unit conversion; actual
pre-exposure remains unchanged. Results
return to the source color domain, including its transparent alpha. Canonical
opaque RGBA16F input and output bypass redundant color and alpha passes. These
local conversions do not tone map the source or change scene-guide meaning.

The saved output `toneMapping` policy selects Automatic, Preserve, Reinhard or
PBR Neutral in that final conversion. Preserve disables final range compression.
PBR Neutral requires scene-referred metadata and an image that has not already
been display mapped; otherwise the final encoder uses Automatic and reports the
reason. Comparison aligns both sides using the same selected mapping before
comparison, followed by one final encoding and quantization dither.

Final game frames default to opaque when display metadata is absent. A
publisher's explicit transparent value is retained through preparation,
processing and presentation. Neural processing normalizes alpha in its private
opaque model input and restores the source alpha in the result; it leaves the
source texture unchanged. Pixel alpha and declared display opacity are separate
parts of the frame contract. Origin, color mode, matching depth, frame ID and
available source timing remain attached to the same image as stages run.
The basic `rsProcessFrame` ABI carries frame ID, color and origin; shader timing
uses the local processing clock when that API supplies no timestamp. The
timestamped presenter and offline video interfaces retain their source timing.
Captured source timestamps and duration remain attached through asynchronous
preparation, publication and same-frame readiness. A later callback does not
replace them with its arrival time. Processed color, origin and attachment
applicability describe the current image independently of retained source
provenance.

Presenter source times use monotonic host seconds compatible with
`CACurrentMediaTime`; offline frame times use the source media timeline in
milliseconds. The two interfaces have separate time origins.
The original libplacebo renderer owns its hook frame clock.
Presenter cadence retains measured source periods above 240 Hz. An explicit
source rate accepts finite values of at least 1 Hz without an upper rate limit;
zero selects observed timestamps. Long source interruptions retain bounded
interpolation timing. These timing calculations do not throttle the renderer.

With frame generation, the prefix processes each accepted real source image
once. Generation preserves the image dimensions produced by the preceding
stage. In Advanced, a scaler before frame generation changes its working size;
a scaler after frame generation processes each delivered real or generated
image. Final fitting maps the completed chain to the native presentation size
separately from the generation working size.
Completed source images establish the interpolation period, so slower
neural processing does not pace generated images from rejected renderer
submissions. Each batch retains that period, its exact chain and source frame
identity. Suffix effects run on each delivered real or generated image with a
separate output sequence and presentation-phase time. Generated images receive
no fabricated game depth or motion. The declared origin remains attached through
processing; the presenter applies its configured final orientation once.

Independent neural processing in ordinary native presentation retains one
source snapshot on the game's command buffer and processes it on an owned
queue after producer completion. It does not submit the game's buffer or make
the next game submission wait for the worker. Busy admission keeps the previous
complete processed output visible. Neural temporal history, scene temporal
inputs, frame generation and explicit presentation targets or observers retain
their producer-ordered execution. Resizing retires queued work whose dimensions
no longer match. Work already scheduled on the GPU can complete, with its
resources retained through completion.

Native view hosts cache the actual output window's occlusion state on the main
thread. The shared presenter pauses new processing and unissued display phases
while that output is hidden, retaining the last complete processed image and
already-admitted GPU resources. Visibility resumes through the existing producer
and delivery clock, with fresh interpolation history instead of queued old
phases. An inactive but visible window remains eligible. Unknown visibility
preserves normal processing, and virtual-window activation retains its initial
completed-image replay until physical presentation is established.

## Geometry reuse and drawable lifetime

Native shader reuse includes output scale and presentation-relative sizing in
the resource identity. Each row also retains its actual input and output image
contract. A final drawable resize preserves source-sized stages whose working
dimensions are unchanged; presentation-sized stages and their affected suffixes
prepare separate state. Rejecting a later row leaves the accepted shader and
its history intact.

Drawable delivery reserves a ticket before calling the Metal presentation
driver. The driver call runs outside the presenter's state mutex, so a
presentation callback can read state without waiting on its own caller. A
ticket retires only after both the driver call returns and the drawable's
presentation or failure callback completes. Held transitions include these
tickets in their drain barrier. Geometry snapshots used by that barrier are
read before acquiring the state mutex. Presenter layer snapshots retain their
ownership under that mutex; Stop detaches the layer under the same lock and
releases it outside teardown locks. Layer properties and driver calls remain
outside the state lock so callbacks can reenter safely.

Owned presentation counts the drawables of its output layer that are acquired,
queued or displayed. A displayed drawable counts until a later one replaces it;
a dropped or unpresented drawable stops counting when it is released. At the
layer's maximum drawable count, a frame skips presentation without requesting
another drawable, since that request would wait up to one second on the thread
that submitted the frame. A presenter logs once when refusals continue for two
seconds.

## Game render allocation and processing extent

These fields control intermediate processing targets, independent of game
render-target allocation. Advanced `renderResolution` controls source allocation
separately: `null` or a missing field preserves the game render size,
`{ multiplier: 1 | 1.5 | 2 | 3 | 4 }` divides both presentation dimensions, and
`{ height: n }` selects an integer height from 1 to 16384 while preserving the
presentation aspect ratio. Requested source dimensions stay within the physical
presentation dimensions. Source control requires an explicit engine or producer
contract; the Godot adapter adjusts its 3D render scale while preserving the
original drawable and 2D rendering. This requires the selected engine helper's
`sourceResolutionAPI: 1` and an active non-XR root 3D viewport using Forward+
or Mobile. Engine scale is constrained to `0.1` through `2`; divisors and
maximum-height requests retain an already lower game-selected scale.
Explicit producers expose their supported divisors through the existing
allocation contract. Other frame adapters retain the source supplied by their
producer. Native video processing retains decoded source dimensions.
Accepted requests and native capabilities are separate: a divisor of 4 uses
completed-frame Downsample when no source adapter supports that allocation.
Both Simple and Advanced source requests prefer a compatible renderer API,
then eligible virtual source sizing. When neither source path is available,
compatible ordered chains use a GPU Downsample stage before their other effects.
An allocation request can include this reduction as a guard for a renderer that
rejects the request after creating its viewport. When the source already meets
that target, the reduction bypasses filtering and allocates no intermediate image.
Divisor targets remain relative to the current presentation; height targets
preserve the input aspect ratio and never enlarge it. This fallback reduces
processing work while game rendering retains its allocation. Temporal,
depth and motion inputs prevent a reduction that would invalidate their geometry.
Launch records and logs retain the requested source, selected strategy and reason.
During a live source change, a rejected renderer acknowledgement restores the
accepted publication and source before one processing fallback attempt. Restoring
Original remains an acknowledged source operation; a failed restoration is reported.
Simple `entry.graphics.spatialMultiplier` retains its source-allocation meaning.
For a maximum rather than an exact source height,
`{ height: 480, maximum: true }` also clamps to the producer's original source
extent. Existing explicit plans can retain this maximum-height form;
Advanced manual height selections use the exact-height form.
Either source-size object can also store `method`, selecting one of the
adapter's advertised source filters. Omitting it preserves the game's original
filter. This selection is independent of spatial effect rows; the Godot adapter
uses it for scene scaling before interface composition. A producer declaring
`filterExclusiveWithTemporal` disables source-filter overrides while a temporal
node is enabled; the original filter remains selectable. Other producers keep
their own filtering contract. Source preparation carries
the selected method in `RESHADE_RENDER_SOURCE_METHOD` for its owning adapter.
The game render texture, each effect target and the
presentation drawable are separate sizes; drawable dimensions use physical
backing pixels rather than window points. Each factor applies to the preceding
row's output. Doubling width and height yields four times as many pixels.

Source allocation is bound at launch through `RESHADE_RENDER_HEIGHT` or
`RESHADE_RENDER_MULTIPLIER`, independent of the selected spatial method.
`RESHADE_RENDER_MAX_HEIGHT` carries the maximum-height source contract.
The legacy `RESHADE_RESOLUTION_MULTIPLIER` retains the Simple spatial method
contract. These variables alone do not authorize resizing arbitrary Metal
drawables. Generic drawable source control is disabled; a cooperating publisher
can explicitly opt in with `RESHADE_RENDER_SOURCE_CONTROL=drawable`.
Engine source adapters adjust offscreen rendering through the renderer's own
scale settings. The presentation view retains native window
geometry, backing scale, display selection and fullscreen behavior.
During resizing, a revealed presentation keeps its last completed processed
image fitted to the current content bounds while replacement targets are
prepared. Queued output is checked against current drawable dimensions before
encoding and scheduling; obsolete output does not replace the resized image.
Automatic frame ownership is restricted to the window content-view subtree;
titlebar, toolbar and other window chrome stay outside game processing.
Ordinary output presentation remains inside the game content's bounds. A native
window host advertising `virtualWindowAPI: 1` can instead use
`RESHADE_RENDER_SOURCE_CONTROL=virtual` for a requested source reduction when no
renderer allocation API is available. This uses an ordinary resizable native
output window and keeps the original renderer and responder in its source
window. Output resizing adjusts source content size; the fitted image rectangle
also defines absolute pointer mapping. Relative mouse deltas retain their
original values. Native titlebar controls and resize borders stay outside the
mapped game image. The source accompanies the output in its fullscreen Space;
miniaturization suspends the pair, and stopping restores the source window.
The output preserves the original content size limits and its aspect ratio or
resize increments in window points. Processing scale does not scale those
constraints. Failed fullscreen transitions reconcile the current geometry and
release transition state. A prepared replacement that has not taken ownership
leaves fullscreen requests with the original native window.
Games that size their interface from window dimensions can also change their
interface layout in this mode. A scene-renderer adapter can keep interface
composition at native resolution.
An unchanged source extent does not create virtual presentation. Native video
and hosts that disable source control retain their original allocation.
No display mode change or fixed screen resolution is required. Each completed
frame carries its current source and
destination extents; previous backing dimensions do not define a later frame's
allocation.

## Live source commands and virtual windows

Renderer source adapters can additionally advertise `sourceResolution.live`.
The inspector preserves this capability for source controls. During play, live
source help follows the current launch's source binding rather than a capability
declaration belonging to another process or an earlier session.
`source-controls.prepare(entry, {userDataDir, support, launchId, source})` creates
a separate command/status channel for that launch and returns its environment
and binding. Unsupported adapters create no channel. A null source leaves an
unmodified game allocation alone. `stage(source, {binding, publication, signal,
isCurrent})` stages an atomic higher-epoch command after the effect plan and
returns `wait()` and `rollback()`. After `publication.commit()`, `wait()` checks
the exact launch, epoch and revision in the renderer's applied result. An unchanged
non-null request also requires its current applied result; unchanged Original
does not wait or publish a new command. A valid existing result returns immediately.
On
failure, callers first roll back the publication, then await the source
transaction's `rollback()`. Source rollback publishes the previous settings at
a higher epoch, since renderers reject older commands. A `false` result means
the source is no longer owned by that transaction; a continuing session reports
the failed restoration and preserves the newer command. The engine adapter
retains its last accepted source on malformed or stale input and restores only
properties it still owns. The Godot adapter provides this live source API with
the versioned helper; other adapters retain their declared allocation contract.
Successful source acknowledgements include finite applied pixel dimensions or
a finite scale with viewport dimensions. Virtual source acknowledgements also
include the observed completed producer extent, matching the applied width and
height; window geometry alone does not acknowledge a rendered source.

The native core's `virtualSourceControlAPI: 1` extends this protocol to a virtual
window requested at launch. `virtualSourceActivationAPI: 1` also permits a
metadata-only null source for initially-off and 1× launches. The existing native
window poll reads this channel only while processing, activation or source
restoration is needed. Untouched Off creates no source reader, virtual window,
capture, model or GPU work.
A core declaring `virtualSourceChannelAPI: 1` can reserve a second dormant
virtual channel beside a native engine or drawable channel. The launch record's
`sourceControls` maps each control to its binding; `sourceControl` retains the
primary binding for older consumers. The dedicated virtual binding uses
`RESHADE_VIRTUAL_SOURCE_CONTROL_FILE`, `RESHADE_VIRTUAL_SOURCE_STATUS_FILE`,
`RESHADE_VIRTUAL_SOURCE_LAUNCH_ID` and `RESHADE_VIRTUAL_SOURCE_ACTIVATION_API`.
Its files end in `<launchId>-virtual.json`, with independent epochs and the same
launch identity. A native source failure excludes that control for the current
update, then tries virtual allocation and finally completed-frame downsampling.
Before changing allocation owners, the publisher restores the previous owner's
Original allocation and awaits its exact acknowledgment inside the renderer
transaction. A failed replacement restores both the accepted graph and source.
An already active compatible owner remains preferred for subsequent edits.
These channels carry prepared control metadata; they add no work to frame nodes.
A live activation prepares output while preserving the original source window's
geometry and input. Its first completed image is retained with the same frame
identity; replay does not rerun effects or generation. Visible activation waits
for a positive presentation callback before changing source geometry. When
both windows remain covered on the active Space, a completed opaque image can
support background activation without taking focus. That image stays retained
for replay when visible; GPU completion is never reported as physical display.
Hidden, minimized or transitioning windows defer activation. A slow first
neural image has a bounded preparation wait; cancellation retains the original.
Applied reduction waits for an acknowledgment matching the completed source.
A publisher already at the requested pixel extent reports `virtual: false`
without creating a proxy. The acknowledgment includes source and presentation pixel
dimensions; a later resize invalidates it until another matching frame completes.
An existing proxy accepts live height and divisor changes, including
while fullscreen, and retains its completed image during source reallocation.
Applied results report the observed producer extent. In windowed mode, a null
or full-size source restores the original window after its restored frame
completes; the same launch can then enable the virtual source again. Enabling
or retiring a virtual window requires leaving fullscreen. Pointer gestures
finish before their source coordinate map changes. Invalid or stale commands
retain the accepted source.

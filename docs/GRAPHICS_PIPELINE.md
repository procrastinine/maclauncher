# Graphics pipeline reference

The [graphics guide](runtimes/GRAPHICS.md) describes the inspector and supported
shader formats. This reference describes the shared contracts used by runtime
modules, frame adapters and effect providers.

Advanced preset metadata lives in `graphics/effects-presets.json` under the
application data directory. The preset store uses the shared effects-plan
validator, atomic writes and revision checks for edits from multiple windows.
It stores up to 128 named snapshots within a 16 MiB metadata limit. Preset
storage does not prepare or publish a running plan. Applying a snapshot uses
the ordinary per-game preparation path, including resource, ordering and
renderer validation. Game records contain the copied plan, with no link that
allows later preset edits to modify the game.

## Runtime and frame adapters

Runtime entries declare a `graphicsHost` through module metadata. The launcher
prepares the shared processor through `context.getGameEffectsEnvironment()`;
`context.applyGameEnvironment(base)` combines its environment with the game's
existing environment. Engine-specific renderer selection stays in the module.

The library UI and `scripts/run-game.mjs` both dispatch through
`createLauncher().launchEntry`. Direct module hosts obtain the same game
context with `getGameLaunchContext(entry, settings, options)`; action contexts
use `getLaunchContext` and leave game effects disabled. The game context owns
lazy preparation, runtime graphics metadata, selected-library merging and the
final process handoff. Modules may replace its graphics getter with the scoped
environment produced by their sandbox before calling `spawnDetachedChecked`.
Callers do not prepare or merge a second graphics environment.

An optional `processAdapter(command, args, options, needsRosetta, spawn)` wraps
that final handoff for inherited instrumentation. Its supplied `spawn`
continuation retains the selected graphics environment, network policy and
process ownership. Component callers can supply `graphicsRuntimeRoot` for
verified preparation assets and `presentationLibrary` for the callable
processor; ordinary launches use the included selection. Boolean
`graphicsDiagnostics` fields (`diagnostics`, `capture`, `gpuTiming`, `trace`)
configure the same preparation path without changing the saved plan.
Detailed diagnostics, GPU timing and frame capture are opt-in. Disabled
diagnostic entry points use cached enable flags and create no recorder state,
writer thread, output file or GPU query. Enabled recorders use bounded queues;
render callbacks drop records rather than waiting for a writer lock. Diagnostic
file writes verify process and file ownership and stop on failure. They are
independent of source acknowledgements and graphics control metadata.
Warning and informational notification failures are contained independently of
preparation and live updates, including rejected asynchronous notifications.
Rendering does not wait for those notifications.

The completed-window adapter can capture the selected original window in the
background on macOS 14.4 and later. It uses an independent ScreenCaptureKit
window source, GPU texture copies and the shared processor when native ingress
supplies incomplete compositor surfaces. Capture starts only for active
processing and does not require bringing the game forward. Producer throttling
can still limit fresh source frames.
macOS displays its screen-sharing indicator while this window capture is active.
Disabling graphics processing or closing the game stops the capture session.
The filter includes the selected game window and excludes child windows; audio
capture is disabled. Frames remain in local processing buffers, with no network
transport or recording file in ordinary playback. Explicit diagnostic capture
can save local before/after images. On macOS 14.4 and later, current-process
window enumeration uses Apple's consent-free API rather than broad desktop
access. The screen-sharing indicator still identifies an active capture stream.
Capture errors retain the original renderer and release the failed session.
Capture configuration changes are serialized and coalesced to the latest window
geometry. Temporary failures receive bounded recovery attempts before returning
to the original window; obsolete callbacks cannot replace a newer configuration.
For launcher-hosted Electron windows, an in-process visibility notification keeps
source animations active while the owned processed output is visible. Covering,
minimizing, disabling or closing that output restores the previous background
throttling policy. The game continues to control its own frame timing.
GPU completion and physical presentation are separate results. Covered output
can complete processing without a positive drawable `presentedTime`. Opt-in
`FrameCapture` records the original and final pixels from one admitted source
after successful GPU completion; these images do not establish display cadence.

In-place Metal and OpenGL effects reuse only a GPU-completed image during
temporary resource pressure. Images must match the current settings and output
contract. Sustained pressure selects stable original rendering until that
contract changes, rather than alternating processed and untreated frames.
OpenGL reuses its bounded interop slots without waiting for command scheduling.
This behavior adds no window wrapper or source frame-rate cap.

`ReShade.executionRequirements(entry, { sourceSupport, diagnostics, activation })` is a pure
settings calculation implemented in `effects/execution-requirements`. It
returns a `mode` (`none`, `activation` or `processing`), `needed`, selected `methods`, shader rows, the source request and a
`components` list with each component's necessity and reason. Shader processing,
spatial and temporal filters, neural rendering, frame generation, source
controls, virtual presentation and explicit diagnostics determine processor
and presentation requirements. LS1/LSFG alone require Lossless Scaling models;
selected FSR temporal methods require their own providers. The calculation
performs no file reads, provider discovery, model inspection, shader parsing or
GPU work. Dormant activation is independent of processor and presentation
requirements. It permits later live changes without enabling any image stage.
The bound launch records it as `launch.json.executionRequirements`.

Launch preparation reads the selected runtime's declaration without building
the Settings catalog of every installed shader pack and model. Payload
verification follows the selected components: the shared core, required shader
provider, selected temporal provider or neural runtime. Verified files are
cached by file identity and their declared checksum, size, permissions and
architecture; a changed file is verified again. Optional component selection
does not bypass its provider's platform or resource validation.
Dormant activation also verifies the core library and its required closure.
An unavailable or damaged optional bridge is omitted before the game starts.

Ordered preparation calculates those requirements after the module's native
renderer routing. It resolves only the remaining selected shader IDs, discovers
the neural provider only for enabled neural rows, and reads Lossless Scaling
model metadata only for LS1 or LSFG. Selected method capabilities omit unrelated
provider discovery. `Effects.info` retains the full installed catalog for the
editor; custom shader rows retain independent compiler and resource validation.

Prepared shader revisions are reused when the selection, runtime root and
process architecture match and the prepared resource remains present. Custom
file identity includes its filesystem identity, size and modification times;
custom selections are prepared again at launch. Unchanged included or
registered selections retain their prepared revision across parameter updates.
Registered sources track filesystem identity and change time, so replacing a
file invalidates its prepared revision even when its size and modification
time are preserved.
FX validation and resource metadata use the frozen preprocessed source that is
published, so edits to an original file during preparation do not change the
program described by that revision.
The offline FX compiler accepts `--prepare EFFECT.fx PREPARED.fx`, followed by
`PREPARED.fx OUTPUT_DIRECTORY` for full validation. Its output includes GLSL and
Metal shaders, `textures.json` image-source names, `uniforms.json` parameter
metadata and `requirements.json` scene-input requirements for each technique.
Runtime staging checks this CPU-only contract before publishing a compiler.
Provider availability is checked when reusing a revision. UI discovery metadata
does not form part of the compiler identity.

Shared presentation hosts prepare the included processor and an empty effect
plan even when optional effects are off. This allows Simple and Advanced effects
to be enabled during play. Unadapted hosts retain their unfiltered launch path.
Dormant live controls install hooks without requesting image processing. Quartz
capture and Metal framebuffer access follow the active plan or live controls;
an empty selection leaves original drawing in place. CRT-only settings request
the shader path without preparing scaling, generation or model resources.
Dormant drawable requests forward directly to the original renderer before
device discovery or command-queue setup. Remote layer hooks defer image-class
probes and publisher state until processing is needed. Existing owned output
retains its normal retirement path when effects are disabled.
When no separate output is active, size-preserving ReShadeFX can process a
readable native Metal drawable directly, including during native window
resizing. Imported shader geometry, reconstruction, frame generation and
explicit source scaling retain their separate presentation requirements.
Owned SDR output validates the source image format and readability before
creating a presentation view; unsupported conversions retain the original
renderer. CGL and remote surfaces keep their respective presentation adapters.
Live activation reserves the two managed graphics-model paths without creating
their directories or inspecting models. A neural library path from the included
provider layout is authorized without inspecting or loading that provider.
Selecting a neural row validates compatibility, the provider inventory and model
contents before publication; imported managed models can therefore be selected
during play. Optional source-control, coordinated-presentation and future-model
channels are prepared independently. An unavailable channel leaves already
prepared graphics stages available and preserves the process architecture and
frame-adapter metadata. No model weights are loaded for an empty plan.

After optional preparation produces a child's environment, the launch core
binds its actual PID once through `ReShade.bindLaunchProcess`. Launches without
the processor do not read or rewrite an earlier graphics record. Main-process
controls supply `runningPids` from the current sessions; live preparation and
validation require a matching `launch.json.pid`. Expired or absent bindings
save canonical preferences for the next launch without compiling or publishing
a live plan. After asynchronous preparation, plan, shader-selection and control
publication rechecks the same launch identity and active session. Stopped or
replaced sessions retain the saved preferences without replacing the current
launch's files. Models outside the launch's authorized stores and selected files,
neural-provider changes, and temporal methods requiring different scene inputs
remain next-launch settings. Callers omitting `runningPids` retain the standalone API contract.
The existing `graphicsInputs` inspection response includes `graphicsLive` for
Simple controls, without model or provider discovery for that binding check.

Live callers can create `ReShade.createPublication({isCurrent})` and pass it as
`options.publication` during validation and preparation. Immutable shader
revisions are prepared immediately; accepted plans, selections and control
files remain unchanged. A renderer update can use the prepared resources before
calling the synchronous `publication.commit()`. Commit revalidates the original
launch and accepted file bytes, publishes complete documents, and writes the
effect plan after its selections and controls. Each file replacement is atomic;
the files are not a shared native snapshot. `rollback()` discards uncommitted
changes or restores committed bytes only while the same launch and candidate
still own every affected file. `deferred` indicates a next-launch setting.

Managed model access acquired for a live candidate belongs to that preparation.
Rejection or cancellation before publication releases its new reservations while
preserving access already held by the running session. Once publication starts,
the session retains candidate access through process retirement; restoring files
does not establish that asynchronous native consumers have finished.

Shader parameter saves can include an `expectedSelection` alongside the patch.
The serialized setter checks the selected preset, custom source and chain order
before preparation. Queued edits from earlier shader controls cannot replace
parameters belonging to a newly selected shader.
Graphics edits retain their order for each game. Leaving an unedited Advanced
preview preserves Simple settings without a runtime update. Stop and resetting
an Advanced chain cancel pending shared graphics preparation; subsequent edits wait for cleanup
and restoration of the accepted settings. Independent partial edits retain
their order. A cancelled preparation cannot publish a later revision.

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
A live activation prepares output while preserving the original source window's
geometry and input. Its first completed image is retained with the same frame
identity; replay does not rerun effects or generation. Visible activation waits
for an actual positive display receipt before changing source geometry. When
both windows remain covered on the active Space, a completed opaque image can
support background activation without taking focus. That image stays retained
for replay when visible; GPU completion is never reported as physical display.
Hidden, minimized or transitioning windows defer activation. A slow first
neural image has a bounded preparation wait; cancellation retains the original.
Applied reduction requires an exact current completed-source receipt.
A publisher already at the requested pixel extent reports `virtual: false`
without creating a proxy. The receipt includes source and presentation pixel
dimensions; a later resize invalidates it until another matching frame completes.
An existing proxy accepts live height and divisor changes, including
while fullscreen, and retains its completed image during source reallocation.
Applied results report the observed producer extent. In windowed mode, a null
or full-size source restores the original window after its restored frame
completes; the same launch can then enable the virtual source again. Enabling
or retiring a virtual window requires leaving fullscreen. Pointer gestures
finish before their source coordinate map changes. Invalid or stale commands
retain the accepted source.

Modules may export `resolveGraphicsInputs(entry, context)` to describe the
selected renderer's inputs and native controls. The same metadata accompanies
runtime status in the inspector. For example, `nativeVideo` identifies decoded
video planes; `nativeSpatialMethods` and `nativeSpatialMethodLabels` describe
the original renderer's filter registry. `sourceResolution` is either `false`
or an explicit capability object with `heights` and `multipliers`; `control`
can identify an engine-owned source adapter. Native window adapters without
this declaration preserve producer allocation unless an included virtual-window
adapter is advertised. `features.graphics.virtualWindowAPI: 1` exposes
`GraphicsCapabilities.virtualWindow` and its supported source factors to the
window host. Explicit source declarations take precedence; `sourceResolution:
false` and native video omit that fallback. The UI reads these capabilities
rather than assuming arbitrary drawable resizing is supported.
`virtualSourceAutoAPI: 1`, together with the activation and control APIs, exposes
`virtualWindow: {activationAPI: 1, autoAPI: 1}`. A compatible source adapter can
advertise `automatic: true`. Simple neural Auto then requests `{automatic: true}`
on its launch-correlated source channel. This request is exclusive with manual
height, divisor and filter fields. It follows the current physical presentation
fitted to the producer aspect: the fitted short edge divided by 540, rounded and
limited to 1–4, determines the divisor. The source adapter preserves an already
smaller natural allocation and follows later output changes. Completed-frame
downsampling uses the same native sizing policy with an input-size clamp.
Older cores and adapters use the processing fallback. Saved Advanced source
requests remain explicit heights or divisors; converting Simple to Advanced
materializes an editable ratio rather than storing an adaptive source request.
Optional `methods` and `methodLabels` advertise source-renderer scaling filters
and their display names.
Explicit frame producers retain their advertised divisors. `shaderBindingsNextLaunch` and
`spatialBindingsNextLaunch` identify settings bound when the process starts.
Status reads use installed metadata and do not start a renderer or query the
network.

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

| Host | Frame source | Ownership |
| --- | --- | --- |
| `window` | Supported native Metal, hardware OpenGL, Core Animation and completed Quartz bitmap frames | The adapter selects the game window and retains its source until GPU reads finish. |
| `remote` | Hosted browser surfaces | The producer supplies its surface and presentation timing. |
| `explicit` | Runtime-supplied Metal textures | The runtime controls ordering, frame identity and submission. |
| `catalyst` | Supported iOS application Metal layers | The adapter preserves drawable and application lifecycle. |

A host declaration describes an adapter, not a guarantee that every renderer in
that process publishes through it. Library-loading restrictions also apply.
Inspection and extraction tools do not declare a presentation host.

Optional `graphicsArchitecture` metadata identifies a fixed host architecture,
using `arm64` or `x86_64`. This describes the process that loads the graphics
library, including a translated Intel host. Renderer input metadata may supply
an actual `architecture` when it depends on the selected runtime. Provider
architecture checks use this value rather than an engine name.
Native app bundles without recorded executable metadata resolve their declared
bundle executable before inspecting its Mach-O slices. Explicit renderer and
runtime architecture declarations take precedence; unknown script architectures
remain unspecified.
Scripted launchers can pass `{needsRosetta: true}` to
`context.getGameEffectsEnvironment` or `context.applyGameEnvironment` before
preparing the child environment. This selects the Intel graphics contract for
the actual translated executable, including optional provider validation.
Changing architecture after binding the game process is rejected.

Metal adapters retain GPU textures directly. Hardware OpenGL adapters use the
shared texture/surface bridge. Supported `CGImage` layer publishers upload one
completed software image into a bounded reusable IOSurface pool. Shader passes
and intermediate images then remain on the GPU. A bitmap image carries color,
dimensions and timing; it does not supply scene depth or game motion vectors.
The Quartz adapter can also retain a full bitmap published during the selected
content view's original `drawRect:` invocation and submit it after drawing
finishes. Individual drawing calls and dirty rectangles are not complete frames.
Direct Quartz drawing that does not publish through a supported frame adapter
remains outside that adapter's contract.

OpenGL context retirement removes graphics ownership before attempting driver
cleanup. An unavailable context leaves its GL objects to native destruction;
independent host resources are released without selecting another context for
deletion.

## Frame inputs and presentation

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

| Operation | Required inputs |
| --- | --- |
| Color, CRT, sharpening and spatial filtering | Color texture and dimensions |
| Depth shaders | Matching scene depth in addition to color |
| Renderer temporal upscaling | The selected provider's matching depth, motion, jitter and camera inputs |
| Neural reconstruction | Color frames and a compatible model; optional estimated flow and provider-owned history |
| LSFG | Opaque SDR color frames, compatible imported models and supported presentation timing |

LSFG's own image-based motion estimation does not supply game motion vectors to
other effects. Neural estimated flow also remains private to its provider.
Renderer temporal inputs are accepted only through their renderer
integration or temporal frame API. Unsupported or mismatched inputs preserve
the original frame and report the processing reason.

## Saved effects and launcher API

Simple settings remain in `entry.reshade` and `entry.graphics`. An advanced plan
uses the following additional field:

```js
entry.effects = {
  schema: 1,
  mode: "advanced",
  renderResolution: { height: 480 },
  video: [
    { id: "colour", kind: "shader", enabled: true,
      shader: { enabled: true, preset: "grayscale", parameters: { V__Strength: [1] } } },
    { id: "scale", kind: "spatial", enabled: true,
      method: "fsr1", settings: { spatialMultiplier: 2, spatialSharpness: 0.5 } }
  ]
};
```

The plan model validates unique stable row IDs, supported settings and finite
numeric values. Limits are 32 rows, 4096 parameter names per advanced shader,
one to four numeric components per value and a 4 MiB serialized plan. Graphics
rows use `spatial`, `temporal` or `frame-generation` kinds and normalized
graphics settings. A `neural` row uses its provider's separate settings contract.
Ordering validation permits one enabled frame-generation row.
Saved plans contain settings and source selections; they do
not assert renderer capabilities or provide native resource paths.

Advanced spatial rows interpret `settings.spatialMultiplier` as an output/input
factor for that row: `0.25`, `0.5`, `2 / 3`, `1`, `1.5`, `2`, `3` or `4`.
A missing or `null` factor selects
the final presentation dimensions. An optional top-level
`outputSize: { width, height }` overrides that factor with explicit integer
dimensions from 1 to 16384 per axis. For example:

```js
{ id: "reduce", kind: "spatial", enabled: true, method: "downsample",
  outputSize: { width: 854, height: 480 }, settings: { spatialMultiplier: null } }
```

`downsample` uses bilinear reduction and defaults to a factor of `0.5`.
Its inspector offers reduction factors and explicit dimensions. Other spatial
rows retain their provider's size requirements and accept the same processing
size fields.
Catalog templates start ordinary spatial rows at Auto independently of the
Simple producer divisor. LS1 shares this spatial target contract; LSFG's
`frameMultiplier` is a temporal rate multiplier rather than an image scale.
Spatial rows can instead store `presentationScale`: `0.25`, `1 / 3`, `0.5`, `2 / 3`,
`1`, `1.5`, `2`, `3` or `4`; Downsample accepts only factors through `1`.
This targets that fraction of the current physical
presentation, fitted to the row input's aspect ratio. It follows resizing and
Retina backing changes without multiplying an already reduced input again.
Saved rows choose either `outputSize` or `presentationScale`.
Explicit `outputSize` takes priority, followed by `presentationScale`, followed
by the input-relative `settings.spatialMultiplier`. Downsample clamps its
result to the input extent, so no size form enlarges that row's input.
Only a `downsample` row can instead specify one axis, such as
`outputSize: { height: 480 }` or `{ width: 854 }`. This is an aspect-preserving
upper limit: an already smaller input retains its size. The other dimension is
derived from that row's input, independently of the presentation aspect ratio.

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
uses it for scene scaling before interface composition. The editor disables
source-filter overrides while a temporal node is enabled; the original filter
remains selectable. Source preparation carries
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
The loading game or processing process must be ARM64; an Intel process running
through Rosetta does not load this provider.

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

The launcher preload exposes these operations:

| Method | Behavior |
| --- | --- |
| `getGameEffects(gamePath)` | Returns mode, a saved plan or view-only Simple draft, the current per-game catalog, source-resolution capabilities and native-binding timing. |
| `getGameEffectParameters(gamePath, nodeId, draftPlan?)` | Describes a shader's parameters without saving or activating the draft. |
| `pickGameEffectFile(gamePath, kind?)` | Selects a local shader or, for `kind: "neural-model"`, a local `.dlssmodel` package or compatible application/ZIP source. Application/ZIP selection imports into the model library and returns its managed path; cancellation changes no settings. |
| `ensureGameGraphicsModel(gamePath, kind, patch?)` | Prepares a compatible neural or Lossless Scaling model for prospective Simple settings. Reuses local models before offering managed acquisition. Returns a model selection or `null` on cancellation without changing the game's settings. |
| `setGameEffects(gamePath, plan)` | Validates and prepares enabled rows before publishing and saving the plan. |
| `resetGameEffects(gamePath)` | Returns to Simple and resets per-game shader/scaling/generation settings to off/defaults. |
| `listEffectsPresets()` | Lists independent Advanced plan snapshots from the local library. |
| `saveEffectsPreset({ id?, name, plan, updatedAt? })` | Creates a snapshot or updates the matching revision without changing games. |
| `deleteEffectsPreset(id, updatedAt)` | Removes the matching revision while preserving applied game copies. |
| `getEffectsPresetEditor(plan?)` | Provides the shared catalog and an inactive plan for the Settings editor. |
| `getEffectsPresetParameters(nodeId, plan)` | Describes parameters in a preset draft without activating it. |
| `pickEffectsPresetFile(kind?)` | Uses the same local shader/model chooser without requiring a game record. |

Opening Advanced does not activate it. A first successful edit saves the plan.
The older Simple fields remain available as migration data until reset. Reset
preserves unrelated game settings, saves, accounts, source files and the shared
filter library. Removing or bypassing a shader does not delete its original file.
At launch, unavailable Simple and Advanced stages are bypassed while independent
supported stages remain active. A failed frame generator does not disable an
independent shader, and a failed shader does not disable a compatible scaler.
In ordered native Metal and OpenGL chains, missing scene or depth inputs bypass
the dependent rows while ordinary color stages continue. Scene processing uses
the renderer's matched inputs; fallback does not fabricate depth or motion.
Saved requests are preserved. `launch.json` records the requested and applied
stages and the reason for each bypass. If shared preparation cannot produce a
compatible chain, the launcher retains original game rendering and logs the
failure. Cancellation still stops launch. Live edits
retain the accepted output when a replacement cannot be prepared.

Simple neural settings stay in `entry.graphics`: `neuralMethod` is `off` or
`mlx-dlss`; `neuralModelPath` is a local model package or `null`;
`neuralInputScale` is `null` for Auto or an explicit processing target relative
to fitted presentation size; `neuralInputHeight` retains legacy migration data that the
Simple automatic plan ignores; `neuralIntensity`
defaults to 1 and `neuralTemporal` defaults to false. Neural processing is off by
default. On first enable, games use `neuralInputScale: null` and native videos
use `1`, with no additional video reduction. Existing numeric values retain
their explicit scale. Auto computes `clamp(round(shortEdge / 540), 1, 4)` from
the current physical presentation fitted to the input aspect ratio, then
divides both axes by that divisor and caps the result to the current input.
It follows window, fullscreen and Retina backing changes without selecting a
fixed display mode. Simple exposes automatic sizing
without a fixed-height control. The automatic plan contains visible reduction,
neural and final-fit rows
when converted to Advanced; its Auto reduction materializes the supplied recent
physical presentation size, or a manual 2× window-relative baseline when none is
available. It does not insert or change rows in an existing
Advanced plan. Live edits can switch validated managed models, enable or disable
rows, reorder compatible stages, and change processing scale, neural intensity,
temporal mode or generation factor. The game's source allocation remains the
one selected at launch; downstream output sizes can change during play. Provider
changes and external model paths without launch read access save for the next
launch without replacing the currently running plan.
The capability-aware Simple draft returned by `getGameEffects` materializes
automatic final fitting. The pure `fromLegacy` compatibility helper can retain
older fixed-height data; the inspector waits for the capability-aware draft
before enabling edits.
`ReShade.automaticResolutionOptions(entry, options)` supplies
`automaticSimple` for a synthesized Simple plan and `automaticResolutionNode`
only for a Simple Auto neural reduction.
`Effects.prepare` writes `resolutionAuto: true` on that prepared spatial node;
this field is runtime metadata and is excluded from the saved Advanced schema.
The native spatial resolver uses the current frame target extent. Preparing a
Simple plan outside `ReShade.prepare` uses the same helper, including native
video's decoded-size default. Auto processing leaves source allocation unchanged.
For native window and engine-composited frames, Simple neural processing retains
the full producer frame and applies one window-relative reduction before
reconstruction. It does not request engine 3D scaling: the engine's prior
upscale and later capture reduction would otherwise resample the same content
twice. This processing reduction does not reduce the producer's 3D render cost.
Explicit producers may reduce full-frame allocation through their own source
contract. The Simple source-divisor control is hidden during neural processing;
its saved preference is used again when neural processing is off.
When launch preparation produces no enabled neural node or final spatial filter,
the Simple automatic plan removes its synthetic reduction and automatic source request. Explicit Advanced rows and
source requests retain their saved behavior. This preparation fallback is
separate from a runtime inference failure, which passes through the current
stage input without changing the process's bound source allocation.

The catalog uses both native presentation capabilities and game-specific input
metadata. Native builds advertise ordered execution through
`features.graphics.effectPlanAPI: 1`; `effectPlanKinds` can restrict the kinds
supported in that ordered path. Simple controls retain their separate native
capabilities. A compiled FX technique's actual texture semantics supply its
depth requirements; technique names and source text are not capability claims.

## Preparation, ordering and resources

`src/modules/shared/effects/plan.mjs` is the browser-safe model.
`plan.js` adds native settings validation and catalog construction.
`runtime.js` prepares immutable shader resources and publishes the native plan.
Preparation returns the requested editor `plan` and a separate `appliedPlan`.
The applied source-resolution request contains the size and optional source
method emitted at launch. Live preparation reports that existing allocation;
unavailable or changed source requests remain in the editor plan. Automatic source reduction is removed when its scaling or
reconstruction stages are unavailable, while manual Advanced requests retain
their saved settings.
Live model defaults resolve to a compatible identity already bound by the
running process when one exists. Otherwise the compatible managed default is
validated inside the process's authorized model store. Explicit managed model
selections can change during play; older sessions without store grants retain
their original model bindings until the next launch.
Ordered temporal edits retain their bound scene methods. Neural edits retain
the provider library and can select validated models within the granted stores.
`composeSimple(entry, {shaderFacts})` orders automatic Simple selections by actual
input requirements and declared shader traits. Source depth and motion shaders
precede geometry changes; imported reconstruction or resizing shaders precede
final spatial fitting and frame generation; ordinary display shaders follow frame
generation. Preparation uses the original compiler's depth and motion requirements
before atomically publishing the final order. `fromLegacy` keeps its literal
before/after conversion, and saved Advanced plans retain their explicit order.
The optional `simpleGenerationPlacementAPI: 1` contract permits source-size
generation followed by final scaling on each real and generated delivery.
Only synthesized Simple plans carry this hint; a saved Advanced plan keeps its
row order. The native owner checks the admitted source and presentation extents,
the final scaler's geometry and estimated generation/scaling pixel work before
choosing a working extent. Fixed custom sizes and unqualified scaler providers
retain output-size generation. API availability and measurement qualification
are separate: `simpleGenerationPlacementQualified` enables the automatic policy
only for a qualified included runtime. The policy changes no source frame cap.
`Effects.info` includes contextual `templates` with a validated plan, availability
and a setup reason. `reconstructionPreset` carries current local model settings
into manual reduction, neural, spatial and frame-generation rows rather than
storing machine-specific model paths in a shared built-in catalog.
The main process serializes edits per game and saves only successful changes.
Explicit edits reject invalid ordering or resource preparation before replacing
the working plan. Ordinary Simple and Advanced launches bypass unavailable or
incompatible rows while retaining independent supported stages and the saved
request. Automatic source reduction is removed when its reconstruction or final
scaler cannot run. Live edits and export preparation use strict validation.
The independent `Effects.prepare({effects}, {fallback: true})` API provides the
same per-row launch fallback for callers that request it explicitly.
Successful standalone Simple methods retain their original runtime path. When
native graphics preparation fails, a supported ordered processor can prepare
the compatible rows instead. Temporal stages still require their original scene
inputs; fallback never invents depth or motion data. Cancellation is propagated.
`preparationStatus` describes requested, applied and skipped shared stages and
requested versus applied source sizing. `launch.json` stores it as
`graphicsPreparation`; `graphicsWarnings` contains structured `{id, kind, method,
reason}` entries for skipped optional Simple features, with a readable feature
name in each reason. The launcher displays these warnings for the matching game
process. If preparation fails before a graphics publication exists, the launch
result carries a separate warning through backend IPC to the inspector. These
warnings do not change the saved settings or turn a successful game launch into
a failure. Preparation status describes resource preparation, not completed neural
inference or display presentation. A non-busy per-frame provider failure fits
that row's retained input across its complete output before independent later
stages continue. Partial writes from a failed stage are overwritten. A busy
provider retains the previous complete image instead of mixing it with a fresh
source frame.

For live ordered edits, `launch-binding.nodeUnavailableReason` classifies each
row against the current process's graphics and model bindings. `effects/live-plan`
projects unavailable replacements onto the previous immutable native rows, or
leaves a newly unavailable row disabled, while compatible rows remain eligible
for the same atomic publication. Both requested and effective ordering are
validated. A retained model row is not prepared again from the future model
selection. Edits with no independently usable enabled stage retain the previous
whole-publication deferral. Compiler failures, cancellation and stale launches
continue to reject the candidate publication.

The saved plan remains the complete requested plan. A successful live
publication also stores `graphicsLivePreparation` in its matching launch record,
with the prepared revision, requested and applied rows, and pending reasons.
Resource retention for partial live edits requires an explicit native resource
acknowledgement for the same launch. A bounded history of four immutable native
documents keeps that accepted graph available if a newer published candidate
was rejected. Missing, stale or conflicting acknowledgements defer the partial
edit; ordinary supported live edits do not depend on status availability.
`runtime-status.acquireAccepted` can acquire that proof during the edit without
an open status panel. It uses a short scoped lease and an asynchronous wait,
bounded to 2.5 seconds or 5 seconds for a selected neural stage. Cancellation
and launch changes interrupt the wait. The prior lease is restored unless
another consumer renewed it. A timeout preserves the current graph and leaves
the request pending; it does not imply a restart requirement.

An untouched dormant activation may prepare independent new stages without
retaining old resources. This requires the exact current launch, its original
empty Simple document, original Off controls and no earlier graphics preparation
or document history. A new unavailable generator can then remain pending while
a compatible shader is prepared. Previously active resources still require
explicit native acceptance. Supported edits, Off and requests with no
independent usable stage do not acquire this lease.
This is preparation state; native completion and presentation remain separate
observations.

The native plan uses `RESHADE_EFFECT_PLAN`, a private JSON file containing a
revision, mode and ordered `nodes`. Simple mode selects the existing Simple
pipeline. Advanced mode with no enabled nodes is a pass-through chain.
Updates publish atomically. Native readers check at most ten times per second
and retain the last valid selection after malformed updates. Shader resources
are initialized before replacing a working execution chain.
Prepared FX bundles resolve frame dimensions for each native stage and again
when that stage's input size changes.

Each enabled row receives the previous row's output. Resize, generated frames
and shaders with unknown coordinate transformations invalidate matching scene
inputs. A trusted coordinate-preserving effect can retain them. The launcher
rejects invalid ordering rather than moving rows or inventing replacement depth
and motion. Per-frame native checks enforce the same input requirements.
Spatial output-size controls apply to every supported frame adapter. A final
fit to the presentation target handles a chain whose last output has different
dimensions; it does not change the game renderer's allocation.

Ordered temporal scope is declared in `features.graphics.effectPlanTemporal`.
The original MetalFX adapter requires a full output covering the exact acquired
drawable and a classic command buffer. Its producer input metadata identifies
`temporalSource: "original-metalfx"`, `temporalOutput: "acquired-drawable"` and
`commandBuffer: "classic"`, in addition to the method's scene inputs. These
facts must come from the renderer integration. Depth and motion alone do not
establish output ownership. A one-use receipt binds the original scene frame,
command buffer and output texture; only the remaining effect rows run at
presentation. Offscreen, subrectangle and ambiguous output paths retain the
original scaler. Simple temporal controls keep their own input contract.

Shader providers share the `ShaderNode` interface: an explicit selection,
per-node parameters and an `encode` call using the caller's command buffer and
textures. Providers own their compiled resources and histories. The shared
executor owns row order and intermediate targets; the presenter owns submission
and display timing. GPU resources remain alive until their submitted reads
retire, including after a row is replaced or removed.
An ordered execution holds at most four intermediate scratch sets. Exhausted
capacity returns busy; completion or abandonment releases the exact set even
when the caller retains a completed command buffer.
Explicit diagnostic frame capture uses the game's private effects directory and
performs readback only for requested frames. Ordinary processing and intermediate
effect passes do not require image readback.

Slang and libplacebo preparation uses a checksummed resource inventory and a
content-addressed cache under `userData/graphics/shaders/`. Per-game selections
link those immutable resources rather than copying an entire provider runtime.
Slang history belongs to an exact command-buffer generation. An abandoned or
unsubmitted predecessor receives separate state, with its resources retained
through late submission or destruction. In-flight shared uniform storage returns
busy until actual completion; no CPU wait or source frame-rate limit is added.
Retaining command buffers preserve the provider's temporary texture views.
The ordinary presenter keeps coherent processed output during that interval.
Generated deliveries encode their suffix in separate presentation command buffers.
RGBA8 Slang frames use BGRA8 working textures and GPU texel transfers back to the
original target format. A 1:1 nearest transfer also accepts render-target-only
outputs without changing their usage or dimensions. Colour normalization does
not change the selected upscaler or its reported method.
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

## Shader selection and native video filters

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
installed pack metadata during status reads. Simple imported upscalers use an
automatic ordered plan without changing the saved editor mode.

Simple `graphics.spatialShader` stores the existing shader-settings shape or
`null`. It is mutually exclusive with a selected native `spatialMethod`, while
the appearance selection in `reshade` remains independent. Conversion produces
an ordinary shader row at the spatial stage after reconstruction and before
frame generation. Intrinsic shader dimensions remain intact; an automatic
spatial fit follows when needed. The source-resolution request remains separate
and follows the same native, virtual and completed-frame fallback policy as
other spatial methods. No provider or virtual window is selected from a neural
description alone.

Spatial parameter edits may pass the expected shader selection as the third
argument to `setGameGraphics`. Its identity includes the preset, source path
and chain order, and is checked inside the game's edit queue before preparing
resources. Replacing an imported source clears only the parameters associated
with that selection, including its Simple spatial slot.

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
neural rows by this transformation.
Simple mpv spatial shaders can run directly on decoded video when no earlier
shared reconstruction stage is selected. With earlier neural or temporal
processing, RGB-compatible spatial shaders remain at their ordered shared
stage. A native shader is removed only from the transient shared entry so it
is not processed twice; its saved settings remain unchanged.

New video records select `libplacebo:ewa_lanczossharp`; game defaults and existing
records remain unchanged. In Simple mode, supported native standard or
`libplacebo:<name>` selections configure mpv's `scale`, `cscale` and `dscale`.
The transient shared entry turns that spatial stage off to avoid duplicate
scaling. Explicit Off retains basic bilinear resizing by the original player.

The mpv manager records `installationMetadata.scaleFilters` from the selected
executable's scaler registry during explicit installation. Failure to inspect
that registry does not prevent installation. The pinned 0.41.0 archive has a
matching version-and-checksum registry fallback; other installations without
metadata retain the minimum standard filters. Status and ordinary selection
read these records without launching mpv or making network requests. The
original player's registry is distinct from the shared libplacebo provider's
registry and platform requirements.

## Local neural models and offline processing

The video module exposes `previewVideo(entry, payload, context)` and
`exportVideo(entry, payload, context)` through its ordinary action metadata.
Preview uses the normal native player launch flow with the saved entry.
Export consumes the saved Simple configuration or Advanced sequence without
creating a separate editor copy. Its fixed output extent supplies the
presentation dimensions used by Auto and `presentationScale`; preceding-stage
factors and explicit pixel dimensions remain independent stage controls.
The inspector opens size and output dialogs; programmatic export payloads may
supply `width` and `height`. A successful result includes `output`, with actual
dimensions available from the exporter. Progress and cancellation use the normal
module-action context. Progress notifications are best effort; observer or warning
sink failures do not interrupt encoding. Invalid helper messages remain errors.
The `processVideo` compatibility action retains the
separate neural-only processing contract described below.
Both offline helpers exclude inherited game injection and live graphics
control variables; selected models, effect plans and output settings are passed
explicitly for the processing job.

The graphics export helper requires macOS 14 or later and one
AVFoundation-decodable SDR video track. It writes H.264 MP4 video with AAC audio,
retaining original presentation timestamps and rotation/mirror metadata.
Compatible RGB ReShadeFX, Slang and libplacebo rows, spatial filters and neural
rows execute in saved order. Native video-plane hooks, renderer scene-temporal
upscaling and frame generation are rejected before encoding; Preview retains
the original mpv video-plane path. Each selected provider keeps its architecture
and macOS requirements. mpv playback and AVFoundation export have distinct
decoder support.

`native/video-frame.h` declares the synchronous C interface used by the export
helper: `rsVideoCreate`, `rsVideoProcess` and `rsVideoRelease`. A version-1
`RSVideoFrame` supplies caller-owned SDR BGRA8 Metal source/output textures,
frame ID, source timeline time in milliseconds and frame duration. One handle
uses one command queue and the prepared ordered plan. Processing submits and
waits for that frame's complete chain, including neural completion, before
returning. This file-processing interface is separate from asynchronous native
window presentation.

The `graphics-neural-models` manager imports local `.dlssmodel` packages into
content-addressed application storage. `neural/model-sources` also recognizes
compatible packages under an application's `Contents/Resources/models`, a ZIP
containing that layout, or a standalone package ZIP. Recognition validates
bounded manifest metadata and declared file sizes without hashing weights.
ZIP import streams only selected manifests, declared weights and notices with
actual expanded-byte limits. The application and unrelated resources are not
extracted or executed. Import retains source filename/package attribution and
notices beside the model, verifies weights checksums and preserves the source.
Raw weights without a compatible manifest are not model import sources. Runtime leases
keep models available while a game or processing child uses them. The live
provider accepts ARM64 processes on macOS 14 or later. The separate neural-only
compatibility command requires macOS 26 or later and an AVFoundation-readable
input; the graphics export helper uses the macOS 14 interface described above.

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

## Sources and distribution

Graphics processors, shader helpers and the included shader collection are app
components. They run offline and follow MacLauncher updates. Runtime selection
does not require a graphics download. Licensed Lossless Scaling model import
remains a separate explicit operation.

Consumed Git sources are pinned submodules. Owned build recipes and overlays
remain outside upstream checkouts. Binary inputs retain exact artifact hashes,
architecture and macOS requirements. An optional provider's newer platform floor
does not change the baseline FX or Slang library's platform requirements.
Its sealed native files declare `optionalLoad: {architectures, minimumMacOS}`;
the launcher loads them only when those requirements match the game process.
Packaging verifies every file's hash, real CPU slices, signature and load-command
floor, including optional files. Required images still cover the package's
baseline architectures and macOS version.
The upstream inventory and component notices record their source and license
identities.

## Runtime processing status

`features.graphics.runtimeStatusAPI = 1` enables optional shared-processing
observations. Launch preparation records `launch.runtimeStatus` and passes
`RESHADE_RUNTIME_STATUS_FILE`, `RESHADE_RUNTIME_STATUS_LAUNCH_ID` and
`RESHADE_RUNTIME_STATUS_TOKEN`. This is inert metadata: preparation creates no
status page or recorder. `runtime-status.read(entry, {userDataDir, runningPids})`
requires the currently bound launch, creates the page for an active inspector
request, and renews a six-second consumer lease. Partial live edits can also
request a bounded acceptance lease through `runtime-status.acquireAccepted`;
they do not enable recording or image processing.
Simple live neural activation uses the same reader while waiting for its first
matching completed neural frame, for up to 120 seconds. Collapsing the details
does not end this bounded activation wait. Completion, a reported current
fallback, Off, Stop or expiry ends the automatic queries. Earlier settings and
unverified stage observations cannot satisfy the wait.

The fixed `MLFXSTS1` page contains eight context slots, each with up to 32 stage
records. Each record uses a sequence counter; readers discard incomplete
updates. Native control polling maps an authenticated page only during actual
processing demand. Observations copy bounded fields into mapped memory without
filesystem operations, allocation, serialization, waiting or a worker thread.
Explicit producers can request discovery through the existing utility queue,
coalesced to at most once per second while processing is enabled. The render
callback only requests the work; it does not open or map files. A mapped page
needs no further discovery task. Off invalidates pending discovery requests.
The mapping keeps no file descriptor. Missing, expired or unavailable status
never prevents rendering or activates processing.

`RuntimeStatusEvent` separates preparation, encoding, GPU completion,
presentation, bypass and failure. Presenter integrations emit presentation only
from a positive presentation callback. Context records include the producer PID
and process start identity, prepared plan revision and controls digest, actual
input/output extents, and stage methods/reasons. Frame counts belong to observations
made while the consumer lease is active; they are neither source FPS nor physical
scanout measurements.
Stopped or older observations remain historical. A prepared-revision mismatch
identifies previous settings rather than relabelling them as the requested
pipeline. An Advanced execution's exact plan revision identifies its ordered
settings even when no controls digest is available. Simple observations require
both identities; missing identities remain unconfirmed. The reader never fills
an observed identity from requested settings.
Current saved requests and per-row pending reasons are combined with
the latest preparation metadata without provider or model discovery.
Pending rows report retained resources only when the exact matching request has
acknowledged retention metadata. Preparation or publication alone does not
establish that an older setting remains active.

`launcher:getGameGraphicsStatus` reads this state without building the effects
catalog. The inspector requests it only while Runtime status is expanded, the
inspector is visible and the game has graphics enabled. Original-renderer
filters outside the shared processor do not acquire a shared completion claim.

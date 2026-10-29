# Frame sources and runtime adapters

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

Shared processing follows the image and scene contracts supplied by an adapter. Runtime and CPU names do not select separate effect implementations.

[Frame sources and scene inputs](#frame-sources-and-scene-inputs) · [Module launch entry points](#module-launch-entry-points) · [Renderer input declarations](#renderer-input-declarations) · [Attachment hosts, CPU architecture and native lifetime](#attachment-hosts-cpu-architecture-and-native-lifetime) · [Completed-window streaming and stable output](#completed-window-streaming-and-stable-output)

## Frame sources and scene inputs

Graphics support follows the frame producer, rather than the game type or CPU
architecture. `graphicsHost` selects an attachment contract; it does not identify
the frame source actually selected during rendering. A Java game, for example,
can publish an OpenGL framebuffer, a Metal drawable or a software bitmap.
Wine can publish Metal through a Direct3D translator or OpenGL through WineD3D.
Those routes use the same corresponding adapters as native applications.

The shared image pipeline receives completed color images. Its frame source can
be direct render-target access, an operating-system window stream, a supplied
texture or a software-image upload. These are distinct operations:

| Frame source | Attachment and GPU handoff | Scene information supplied by this route |
| --- | --- | --- |
| Native Metal drawable | `metal.mm` intercepts the selected drawable and its command buffer. Eligible size-preserving FX can run in place; other chains use owned presentation. This also covers Metal output from Java and Wine translators. | Matching depth can be retained from a supported render pass when requested. A Metal drawable alone supplies no motion vectors, jitter or camera projection. |
| Hardware OpenGL framebuffer | `opengl.mm` and `opengl-interop.mm` receive the game flush, copy its framebuffer into CoreVideo/IOSurface GPU images and submit Metal processing. This includes compatible Java OpenGL and WineD3D output. | Matching default-framebuffer depth can be copied when present and requested. No game motion vectors, jitter or camera projection are inferred. |
| Core Animation surface | `window.mm` and `layer-presentation.mm` receive published IOSurfaces or supported layer images. The adapter admits a full selected-window image before processing; a compositor tile is not a complete frame. | Composed color only. |
| Completed software bitmap | Supported `CGImage` layer publication or a complete bitmap produced during the selected view's `drawRect:` is uploaded to a reusable IOSurface. Subsequent effects run on the GPU. | Color and image geometry only. The software producer's original pixels are already in CPU memory. |
| Browser window stream | Dedicated Electron/NW.js hosts can use `browser-frame.mm` when native compositor surfaces do not provide the complete window. ScreenCaptureKit supplies the selected window's composed image; CoreVideo and GPU copies supply the shared processor. | Composed color only; no renderer depth or motion vectors. |
| Explicit runtime textures | A runtime calls `rsProcessFrame`, its depth variant, or the presenter API with its own Metal textures and producer synchronization. Android presentation integrations use this contract. | Color, plus only the matching inputs explicitly supplied by that producer. The graphics host declaration alone does not add scene data. |
| Native mpv processing | mpv applies compatible shader prefixes and scaling to its decoded video, with original video planes and decoder color metadata. Shared suffix effects receive the post-mpv RGB image through the player's actual Metal/OpenGL frame adapter. | Original video planes belong to the mpv prefix. The shared suffix has composed RGB, rather than game depth or motion vectors. |
| Decoded GPU video host | `video/native/mpv-render.mm` retains decoded GPU surfaces and submits them to the shared graph before window fitting. Paused redraws retain content identity. | Decoder color/format metadata and source PTS; no game scene guides. |
| Offline video frames | `video-frame.mm` and `graphics-video.mm` import decoded sample buffers as GPU textures for the shared frame API and pass completed output to the encoder. | Decoded color and media timestamps; no game scene inputs. |

Owned presentation keeps the source layer's contents mapping. A Metal drawable
or Core Animation surface whose layer stretches the whole image over its bounds
(resize gravity, full contents rectangle and center) is presented at the
view's backing extent. Any other mapping, such as Java's top-left drawable that
is taller than its view, is presented at the publisher's own image extent with
the same gravity, contents rectangles, contents scale and orientation, so
processing neither rescales the image nor shows pixels the original layer
clips. Drawable resolution reduction keeps that presented extent at the size the
publisher requested.

Only the browser window-stream row denotes ScreenCaptureKit window capture.
It is enabled through the authenticated per-launch channel created by
`shared/web/runtime/browser-graphics.js` for dedicated browser hosts. A
`graphicsHost: "window"` declaration does not enable that channel for arbitrary
Java, Wine or native applications. ScreenCaptureKit displays the macOS sharing
indicator while its stream is active. Direct Metal/OpenGL interception does not
use that stream. GPU texture copies in either route do not imply CPU pixel
readback or ordinary recording files.

Color shaders, derived luma/chroma processing, resize nodes and compatible
image-based neural effects consume the common color contract. Color-pair frame
generation additionally needs consecutive images and an owned presentation
timeline. Their image processing can therefore be shared across producers.
Opacity belongs to the producer's frame contract. Opaque display images retain
all RGB pixels even when their storage alpha is unused or zero. Transparent
images retain their declared straight or premultiplied alpha through compatible
filters, including libplacebo processing.
The selected model/provider still determines its color, format and platform
requirements. Original subsampled decoder planes remain different from luma and
chroma derived from a composed RGB image.

Scene effects have a separate input boundary:

| Scene producer | Supplied information | Processing boundary |
| --- | --- | --- |
| Original MetalFX temporal call | The actual color, depth, motion, jitter and output from the intercepted scaler call; camera data only when separately supplied. | A same-command receipt binds the original scene and exact output. Ordered replacement additionally requires the supported acquired-drawable/output contract. |
| Godot renderer integration | The helper registers actual projection and renderer resources; the matching original MetalFX call supplies its command buffer and jitter. | The bridge publishes that matched scene to the shared boundary. Metadata registration alone does not create a scene producer for another renderer. An ordinary window attachment retains its frame-adapter inputs. |
| Streamline through the DXMT bridge | Actual tagged game resources and supplied camera/projection constants. | The owned API adapter translates the game's scene request and retains its per-context resources. The selected native reconstruction method is reported separately from the game-facing API. |
| XeSS D3D11 through the DXMT bridge | Actual game color, depth, motion, jitter and exposure. The XeSS interface does not itself supply camera projection. | Compatible requests enter the MetalFX producer and shared ordered scene boundary. The executing native method is independent of the game-facing API. Methods needing projection data require a producer of that data. |
| Explicit temporal frame API | The caller's matching textures, camera/scale data, flags, frame identity and command buffer. | `rsProcessTemporalFrame` validates the selected provider's actual inputs. |

The D3D11 Streamline adapter copies `OnlyValidNow` input tags on the owning GPU
context before the original tag call returns. These snapshots retain the exact
region, format and frame identity through evaluation and GPU completion.
Longer-lived tags retain their original resources. Both routes preserve the
original SDK call and its output when optional shared processing cannot acquire
the required resources.

Compatible in-game XeSS D3D11 translation is selected independently of optional
shared postprocessing. It preserves the original game DLL and base upscaling
when postprocessing is Off. D3D12 and Vulkan translation require a translator
that exposes matching textures and command insertion; these game routes retain
their original libraries. The separate MacLauncher XeSS compute provider uses
its own GPU host and the shared scene contract.

An engine adapter is a producer of data, rather than an effect eligibility rule.
Godot has no separate effects pipeline. Its scene supplier attaches to native-window
viewports; offscreen viewports retain their own compositor and scaling. The shared
completed-image path remains available. A matching scene frame from another
producer can use the same compatible reconstruction or generation provider.
Depth-only filters, scene reconstruction and scene generation declare their own
required inputs; camera matrices, exposure, reactive masks and HUD-free color
remain distinct optional or required resources for each operation. Temporal
inputs are separate from other renderer inputs such as normals, albedo and
lighting buffers.

The scene producer and executing algorithm are separate choices. Genuine Intel
XeSS appears as a temporal upscaling implementation in the shared graph. It
consumes normalized color, depth, motion, jitter and exposure; camera projection
is not an additional XeSS SR requirement. The game's CPU architecture and
original upscaling API do not determine eligibility. The D3D12 implementation
uses an isolated compatible compute host and the unmodified Intel runtime.
Metal GPU commands transfer the scene through shared images and aliased D3D12
buffers; the launcher transports setup metadata only. The launcher watches for
compute-host setup requests only while a prepared plan has an enabled XeSS row
or one of its hosts still runs. A rolled-back live publication restores the
watch state of the plan it leaves running: a plan with an XeSS row keeps the
watch, and a plan without one stops it at once when no host runs. Launch preparation and live edits
each register their XeSS hosts and bind them to the running process. The host
table written for the launch keeps every route and names its latest
registration; a setup request is claimed exactly once, by the registration its
route names. Backend selection belongs
to XeSS Options. In-game XeSS API translation remains a renderer compatibility
function and identifies the actual executing Mac reconstruction algorithm.

Depth alone permits compatible depth shaders; it does not establish temporal
upscaling support. Window framebuffer, drawable and explicit depth images carry
no camera projection, so they are copied only for rows that read depth alone.
Image filters that unproject depth need a renderer-supplied projection; without
one they bypass with the reason that the frame source supplies no camera
projection.
Depth images are oriented like their color image and keep the renderer's depth
range and encoding. ReShade `.fx` rows interpret reversed, logarithmic or
rescaled depth through the game's depth-input definitions (see
[Effect plans](EFFECT_PLANS.md#depth-input)).
Scene frame generation has its own depth, motion, camera and
history requirements. Image-estimated flow inside LSFG or a neural model is not
exported as genuine game motion vectors. Generated color frames do not acquire
matching renderer guides merely by retaining the source frame's identifier.

Rosetta changes the ISA of the process loading the graphics core; it does not
change the frame source. An x86_64 Wine or Java process can use the same Metal or
OpenGL adapters as an ARM64 process. ARM64-only neural execution uses the GPU
helper boundary, while MetalFX availability follows the actual device, OS and
framework support. None of these declarations is a per-game renderer whitelist.

Source sizing is separate again. Post-render downsampling changes the submitted
image. Engine controls or the owned virtual-source protocol can change the
producer's allocation only after that producer acknowledges the requested size.
Window-stream dimensions and final output fitting do not prove a smaller game
render target.

## Module launch entry points

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

The final native handoff checks the executable's code-signature policy before
attaching the shared processor. Confirmed restrictions leave the game running
without that attachment and record the reason in its launch binding. Unknown
signing facts remain eligible for attachment. A launch transport can supply
`graphicsExecutable` with its actual executable, or `null` when the descendant
is unknown; this metadata is consumed before process creation. Rosetta wrapping
happens after the check.

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

## Renderer input declarations

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
Source sizing uses explicit heights or divisors. Simple neural processing starts
with a 540-pixel input height; an available source adapter may apply that fixed
height before completed-frame processing. Smaller natural inputs remain intact.
The existing `virtualSourceAutoAPI` and `automatic: true` source protocol remain
compatible with older prepared consumers. They do not add an Automatic choice
to Downsample. Historical automatic graph extents normalize to an explicit
540-pixel height, so editor and execution use the same dimensions.
Optional `methods` and `methodLabels` advertise source-renderer scaling filters
and their display names.
Explicit frame producers retain their advertised divisors. `shaderBindingsNextLaunch` and
`spatialBindingsNextLaunch` identify settings bound when the process starts.
Status reads use installed metadata and do not start a renderer or query the
network.

## Attachment hosts, CPU architecture and native lifetime

| Host | Frame source | Ownership |
| --- | --- | --- |
| `window` | Supported native Metal, hardware OpenGL, Core Animation and completed Quartz bitmap frames | The adapter selects the game window and retains its source until GPU reads finish. |
| `remote` | Hosted browser surfaces | The producer supplies its surface and presentation timing. |
| `explicit` | Runtime-supplied Metal textures | The runtime controls ordering, frame identity and submission. |
| `catalyst` | Supported iOS application Metal layers | The adapter preserves drawable and application lifecycle. |

The host's renderer connects through its declared presentation adapter.
Inspection and extraction tools run independently of presentation hosts.

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

## Completed-window streaming and stable output

The completed-window adapter can capture the selected original window in the
background on macOS 14.4 and later. It uses an independent ScreenCaptureKit
window source, GPU texture copies and the shared processor when native ingress
supplies incomplete compositor surfaces. Capture starts only for active
processing and does not require bringing the game forward. Producer throttling
can still limit fresh source frames. A browser helper whose sandbox refuses the
effect plan path admits no native full-window surface, so the completed-window
adapter in the launcher-side process, which reads every edit, processes the
window.
macOS displays its screen-sharing indicator while this window capture is active.
Disabling graphics processing or closing the game stops the capture session.
The filter includes the selected game window and excludes child windows; audio
capture is disabled. Frames remain in local processing buffers, with no network
transport or recording file in ordinary playback. Explicit diagnostic capture
can save local before/after images. On macOS 14.4 and later, current-process
window enumeration uses Apple's consent-free API rather than broad desktop
access. The screen-sharing indicator still identifies an active capture stream.
Capture errors retain the original renderer and release the failed session.
A settled stream whose complete images keep a different extent or pixel format
from the configured window for one second is a recoverable capture error.
Capture configuration changes are serialized and coalesced to the latest window
geometry. Temporary failures receive bounded recovery attempts before returning
to the original window; obsolete callbacks cannot replace a newer configuration.
For launcher-hosted Electron windows, an in-process visibility notification keeps
source animations active while the owned processed output is visible. Covering,
minimizing, disabling or closing that output restores the previous background
throttling policy. The game continues to control its own frame timing.
GPU completion and physical presentation have separate callbacks. Covered output
can complete processing without a positive drawable `presentedTime`. Opt-in
`FrameCapture` records the original and final pixels from one admitted source
after successful GPU completion.

In-place Metal and OpenGL effects reuse only a GPU-completed image during
temporary resource pressure. Images must match the current settings and output
contract. Sustained pressure selects stable original rendering until that
contract changes, rather than alternating processed and untreated frames.
OpenGL reuses its bounded interop slots without waiting for command scheduling.
This behavior adds no window wrapper or source frame-rate cap.

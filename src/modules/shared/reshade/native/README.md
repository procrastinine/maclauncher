# Shared graphics integration

This directory holds MacLauncher's own source overrides for the shared native
graphics library, the graphics processor that games load.
[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds)
compiles the overrides together with the vendor sources at their recorded
commits. The resulting library retains the existing effects, scaling, frame
generation and native presentation entry points.

A producer, the code that renders frames and hands them to the processor, can
ask for a frame to be presented at a specific time. For this, `target-time.h`
adds the optional `rsSubmitFramePresenterAtTime` and `rsGetFramePresenterTiming`
entry points without changing the existing C ABI structures. Targets use Metal
host time in seconds, in the Mach uptime domain, and a target more than one
second ahead is rejected before encoding. When the producer's command buffer is
scheduled, a future target uses timed presentation, while an elapsed target
presents as soon as possible. The original request remains available for timing
statistics, and only positive drawable presentation callbacks count as displayed
frames. In addition, `rsSubmitFramePresenterAtTimeObserved` reports each
accepted frame's retirement, including occluded or dropped output, cancellation
and GPU errors. Its callback runs outside presenter locks after GPU use ends. A
dropped frame has no display timestamp, so native buffer fences can retire
without counting that frame as displayed. Existing presentation entry points
remain unchanged, and targeted submission does not support frame generation.

Ordinary display-driven presentation can report retirement as well.
`presentation-observed.h` adds `rsSubmitFramePresenterObserved`, which keeps
frame generation and adds retirement callbacks. The selected runtime advertises
it with `graphics.observedPresentationAPI: 1`, and callers resolve the symbol
before submission. When a source frame is accepted, its observer context is
transferred until one final callback: real display, drop, cancellation or GPU
error. Generated outputs do not retire that source observer. This callback is
also independent of the producer-token release callback, and positive
presentation times identify the actual display of a real frame. A rejected
frame, by contrast, transfers neither the context nor producer-token ownership.
Because ABI1 encoding can leave partial work on a rejected command buffer, the
caller keeps the source storage until that buffer completes or is discarded.
Only the caller submits the borrowed command buffer.

Ordinary and targeted presentation both register when Metal schedules the
producer's buffer, without waiting for its GPU work to complete, and discarded
buffers and retired presenters issue no presentation requests. The scheduling
callbacks do not acquire the producer submission lock, which may be waiting for
a drawable.

The launcher configures the library through launch variables in the process
environment, which `native-config.hpp` collects into one launch configuration.
The library reads them once, at first use, so later environment changes do not
apply. `RESHADE_EXPLICIT_HOST=1`, for example, selects an explicit frame host, a
host that submits its own frames. A host that loads the library before selecting
that mode calls `rsSetExplicitHost(1, enabled)` instead, which returns 1 when
applied and 0 for an unsupported version or value. Hooks installed while the
library loads, however, follow the launch environment. `RESHADE_CAPTURE_TRIGGER`
names a request file for frame capture: a utility-queue timer removes the file
within 250 ms, and the next frame is captured. The launch configuration also
holds the legacy temporal selection (`RESHADE_TEMPORAL_*`), diagnostics
(`RESHADE_DIAGNOSTICS`, `RESHADE_TRACE`) and the presentation hold channel
(`RESHADE_PRESENTATION_*`).

Some launch variables name files that carry commands while the process runs.
Live controls and the temporal control file are read at most ten times per
second per thread, while the presentation hold, browser frame and render-source
channels read their files when they change. The render-source and browser-frame
channels read their variables when they are used.

The effects to run are described by a plan file, which the launcher publishes
and names in `RESHADE_EFFECT_PLAN`. `effects-plan.hpp` reads this file with one
reader per process, which parses each publication once on its own serial queue.
To notice publications, a directory watch observes atomic replacement and a file
watch observes in-place writes, while a two-second timer covers missed events.
The first query waits for the launch plan. After that, consumers read the
published snapshot and its demand with atomic loads, so a frame performs no file
or environment access to check the plan. A forced poll reads the file on the
reader's queue first.

A document that cannot be read, whose top-level structure (envelope) is invalid,
that has more than 32 rows or that uses a newer schema is rejected as a whole,
and the last accepted plan stays published with the error. Within a readable
document, however, each row and the output block are validated on their own. An
invalid or unsupported row stays in place as a disabled row with its reason,
which the reader logs and executions report as a bypassed stage. An invalid
output block falls back to the default output settings.

Each publication also tells producers what work the plan needs. The reader
derives this demand once per publication: processing or pass-through, depth,
scene inputs, the scene-frame and attachment masks, frame generation, the
presentation queue, an independent image queue for neural rows, and
native-FX-only chains. Producers check it with one load (`effectPlanDemands`)
and do no work for an input the plan does not use, and a disabled or rejected
row demands nothing. A layer that the window resolver has not accepted reads the
demand without creating an executor.

Temporal encoders report under their own status context, and after each encoded
scene, an encoder reports the revision it applied. When a presenter consumes
that output, the presenter reports the frame's stages under its own context;
output that nothing consumes keeps them under the encoder. An encoder that stops
producing ordered scene output, or whose owner is released, reports Stopped.

In automatic mode, the adapter finds a game's Metal layer itself and reuses a
weak direct binding to its view. Replacing the layer or destroying the view
returns to discovery, and the current window ownership and dimensions are still
checked on every frame. Remote surface discovery uses a bounded retained
ancestor stack, without allocating a vector per frame. Attached full-window
IOSurface layers share the bounded local view ownership of bitmap layers and use
the shared GPU processors without CPU image conversion.

A remote surface can appear before its window's context is registered. The
adapter then keeps the latest unchanged source until that context and its extent
are bound, and processes it once. Replacement and context retirement cancel
pending work. Pending sources also share the bitmap storage budget, with at most
32 publishers and 64 MiB per surface.

When a game presents a drawable through its command buffer, the adapter records
the requested drawable and encodes effects immediately before that buffer
commits. Applications may request presentation while an encoder is open, or
encode more writes afterward, and the adapter preserves those writes and the
original presentation timing. Pending drawables belong to the command buffer and
retire when it commits or is discarded.

Some drawables are attachment-only: their `framebufferOnly` property allows
rendering to them but not reading them. On Apple GPUs, these drawables keep
their original property, and programmable blending copies their final color into
a bounded GPU snapshot on the producer command buffer instead. Ordinary color
effects then write back through a render pass, while scaling and frame
generation consume the same snapshot through the shared presenter. This path
preserves RGBA8, sRGB and alpha, uses at most three slots per layer and 256 MiB
across layers, and introduces no CPU readback or completion wait. Renderers that
already permit texture access keep the direct path, and devices without
programmable blending keep the existing readable-drawable path.

The presentation API accepts producer dimensions independently of the output
layer dimensions. With optional spatial processing off, ordinary bilinear
presentation still fits a game's native or dynamic-resolution buffer to the
window, without changing the producer's requested dimensions.

A virtual window lets a game render at a smaller source size when its renderer
offers no way to change its own allocation: the game is shown in a separate
output window, a proxy, while the original renderer stays in the source window.
For an already active virtual window, `source-control.hpp` reads bounded,
per-launch JSON commands that change the source size. Requests use monotonically
increasing epochs and exact launch identities. On the main thread, the adapter
changes the source geometry through the existing window layout path, so the
fitted output and pointer map are preserved. `virtualSourceFrameReady`
acknowledges a request only after a completed producer frame matches the actual
source extent.

When a windowed game returns to Original, the proxy is kept until that restored
frame completes and is then retired, and a later request can enable it again.
Active fullscreen proxies accept source resizing, but changing between original
and virtual windows requires leaving fullscreen. The two-argument
`stopVirtualWindow` checks the target's identity, so retiring an old presenter
cannot stop its replacement; the original one-argument helper remains available.
Windows whose control starts off create no controller or polling timer.

Virtual source control requires a renderer view that covers the window content.
The renderer declares whether source pixels use backing coordinates or one pixel
per point, and source sizing and completed-frame acknowledgments use that same
contract, including low-resolution OpenGL on Retina displays. An output that is
being retired keeps reading back its source until its final source frame
completes, even when the source and presentation dimensions have become equal.

For Catalyst apps, layer presentation inserts the common output beneath the
existing UIKit child layers, without replacing their views or input routing. It
requires an opaque Metal source. Resolution multipliers resize the actual game
drawable before allocation, while the window dimensions remain unchanged.

The OpenGL adapter keeps a context's profile and acceleration result until its
renderer changes. Its effects also leave the game's state as they found it:
transfer paths preserve texture unit zero, and native GL effects preserve all
supported shader bindings. Both paths restore the caller's active texture and
rendering state, including distinct legacy front/back polygon modes, and also
when a frame changes size.

When a context is destroyed, the adapter removes its ownership before driver
cleanup. If the context cannot be selected, its GL names are left to native
context destruction, while independent Core Video and Metal resources are
released. Cleanup never deletes those GL names through a different current
context.

Effects can load PNG lookup textures from the effect folder and from
`RESHADE_TEXTURE_PATH` directories. These images are decoded and uploaded to the
GPU during effect initialization. R8, RG8 and RGBA8 images keep linear numeric
channel values, so sRGB sampling remains an explicit shader choice. Images are
limited to 64 MiB of decoded RGBA data and 256 MiB of texture storage per
effect. Shaders that require Metal rendering features automatically use the
shared Metal processor from OpenGL, through GPU texture interoperation.

The build recompiles the directly linked native host units and the diagnostics
archive, and reuses unchanged vendor archives. It also rebuilds the changed
ReShade compiler units into `libreshadefx.a` and relinks both `fx-compile` and
the runtime library, while the vkd3d shader translator binary is reused. Before
the library is accepted, the build and packaging steps run a plan check against
the linked library. This check verifies that the parser and the temporal reader
agree on shader, disabled and temporal rows, concurrent requests and late
shutdown. The packaged component includes the applied MacLauncher sources
alongside the original vendor sources at their recorded commits, and their
notices.

[MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds)
assembles these sources into one source tree and builds the production component
from it. Native test executables are excluded from this default build:
`-DBUILD_TESTING=ON` enables their targets, and the Builds graphics recipe
supports `BUILD_TESTING=ON` for these native fixture targets. A fixture build
that already exists runs with:

```sh
node src/modules/shared/reshade/native/test/run.mjs /path/to/work/core/build
MACLAUNCHER_NATIVE_FIXTURES=/path/to/work/core/build node --test tests/graphics-native-fixtures.test.js
```

Offline processing needs to know whether a libplacebo frame actually succeeded.
For this, the optional libplacebo provider exposes `rsLibplaceboNodeCompletion`
alongside its ABI-1 factory, and after a frame's GPU command buffer completes,
offline processing queries this entry point before accepting the output.
Asynchronous shader failures therefore remain errors, even when the provider
restores a valid passthrough image for live presentation. A provider without
this completion entry point requires a graphics runtime update for offline
processing.

Depth effects need the game's depth image together with its color.
`frame-depth.h` adds optional frame and presenter submissions that carry depth
as a borrowed, shader-readable R32Float or Depth32Float texture, with the same
source dimensions, device, identity and origin as the color image. The supplied
command buffer determines the producer's ordering, and a Depth32Float input is
sampled into R32Float on the GPU. These APIs preserve raw depth and do not infer
projection parameters. Existing color-only structures and entry points are
unchanged.

The Metal processor supports up to eight color attachments per pass and stencil
testing owned by the effect, including read/write masks, comparisons and
operations. An effect's stencil is cleared at its first use in each frame and
reused by later full-extent passes, and it is separate from the game's depth
attachment. To pair depth with color, automatic Metal capture associates only
stored depth with the presented color in the same command buffer, and it
invalidates that association when encoder store actions change. OpenGL capture
uses compatible default-window depth, whereas remote color surfaces and hosts
that do not submit depth keep their color-only contract.

Compute passes use the shader's declared threadgroup size and dispatch counts,
and sampled textures, samplers and writable 2D storage views are bound through
the compiled Metal resource indices. Storage mip levels share the original
texture, preserve history between frames and are reset on resize. Compute and
render passes use the same command buffer with tracked resource dependencies,
and no CPU pixel transfer is required. Integer, normalized, packed
RGB10A2/RG11B10 and floating-point formats map to their corresponding Metal
formats, and compilation checks texture dimensions against the selected Metal
device's limits.

ReShadeFX accepts readable RGBA16Float, RGB10A2Unorm and BGR10A2Unorm color
frames and preserves their range and alpha through format-matched passes.
Hardware sRGB texture views and sRGB render writes, however, require compatible
8-bit formats. PNG frame capture accepts RGBA8 and BGRA8 frames, and other color
formats continue processing without PNG readback. In owned presentation, where
the processor presents its output itself, the overlays use SDR BGRA8 output and
do not inherit the source layer's HDR metadata. Extended dynamic range Metal
layers keep their original presentation, although compatible FX can process
their original drawable in place. Neural rendering keeps its SDR 8-bit contract.

Automatic Metal processing retries rejected images when their device, format,
extent or framebuffer access changes. An identical rejected image keeps the
original rendering without repeating shader preparation.

To read shaders written with Windows paths, the compiler's preprocessor accepts
Windows separators in shader include paths and `exists` checks, without altering
ordinary string literals. Legacy texture offset and gather names use ReShade's
original compatibility aliases and sampling operators. This preprocessor
adaptation retains its BSD-3-Clause header, and the MacLauncher Builds recipe
selects it through MacLauncher's own `CMakeLists.txt`.

ReShade effects can declare uniforms whose values come from a named source.
`uniform-sources.hpp` provides per-effect timer, frame time, typed frame count,
ping-pong animation, bounded random and local date sources. Their annotations
are looked up after compilation, and animation advances once per frame, shared
by every pass, while each effect owner keeps its own state. Image sources accept
PNG, JPEG, BMP and the first frame of GIF files and are resized to the shader's
declared dimensions during loading, although matching lookup images keep their
original samples. Compressed and decoded images have separate bounded size
checks.

To avoid compiling the same shader twice, Metal effect initialization reuses
immutable shader libraries for the same device object, exact generated source
and default compile options. This shared cache keeps at most 128 libraries and
32 MiB of source text. Concurrent requests for a source that the cache has
accepted share its compilation, while unrelated cached sources remain available,
and failed compilations are not kept. Pipelines, uniforms, animation state,
samplers and textures, by contrast, remain separate for each effect owner.

Live controls are the graphics settings and shader parameters that change during
play. The launcher publishes them as an atomically replaced 19,116-byte
`MLFXCTL2` packet, which contains bounded graphics settings, effect identity and
revision hashes, and up to 128 scalar/vector uniforms. Native readers validate
the packet and poll at most ten times per second per producer, and the shader,
uniform and presenter readers share a thread-local snapshot. When the file is
unchanged, its contents are not read again, and an unchanged selection reuses
the cached configuration without allocation.

Sometimes a renderer setting and a shared effect change together.
`graphics.presentationHoldAPI: 1` coordinates such a change while an existing,
visible opaque SDR view overlay remains on screen, so that the image stays
frozen until both sides agree. Version 1 supports ordinary owned overlays as
both source and destination. It does not create an overlay for an all-off or
in-place source, remove presentation, or transfer virtual or Catalyst output.
Independent renderer and shared-effect updates keep their separate live paths.

This presentation hold is driven through a control file and a status file. A
launch binds `RESHADE_PRESENTATION_CONTROL_FILE`,
`RESHADE_PRESENTATION_STATUS_FILE`, `RESHADE_PRESENTATION_LAUNCH_ID` and
`RESHADE_PRESENTATION_TOKEN`, and the sibling files are named
`presentation-control-<launchId>.json` and
`presentation-status-<launchId>.json`. Bounded schema-1 commands contain the
launch and token identity, an increasing `epoch`, `transactionId`, `action`, and
`expected: {planRevision, controlsDigest}`. Here `controlsDigest` is a hash that
covers the complete exact `MLFXCTL2` packet. A `hold` command also requires
`candidate: {planRevision, controlsDigest, requiresPresentation: true}`.

A transaction proceeds in steps. `hold` drains the issued drawables before
reporting `held`. After the renderer options and the shared publication agree,
`present` arms a matching producer frame, while `cancel` arms the original
contract after a rollback. `presenting` confirms that acceptance of that frame is
armed, so a paused renderer can request a redraw. `presented` and `cancelled` require a
positive actual drawable display timestamp and drained presentation work, and
the image remains frozen through these acknowledgments. A final durable `finish`
command then resumes continuous output and reports `finished`. Stop removes the
output regardless of the transaction's state.

Every status includes `holding`, which reports whether the hold's own lease on
the display remains active, including after a failed update. Native
input-contract changes reset reconstruction and generation history, even for
otherwise identical shared plans. An idle channel allocates no additional image
or model resources.

Effects normally run before spatial scaling. Flag bit 5 places them after
scaling instead, and `RESHADE_EFFECT_PLACEMENT=after` provides the same choice
for a launch configuration. Effects placed after scaling use the scaled image
directly as their first color input and run at output resolution. When the image
is resized, depth effects require placement before scaling, so that color and
depth keep matching dimensions. Temporal reconstruction remains in the game
renderer, and LSFG receives the completed effect and scaling output. Changing
the placement invalidates LSFG history.

Shader changes during play come from a per-game directory, named by
`RESHADE_LIVE_EFFECTS`, of immutable preprocessed effects and their declared
image inputs. The launcher validates each revision before publishing it, and
Metal and OpenGL create replacement effect resources before retiring the
previous pipeline. Source-based uniforms remain controlled at run time. Explicit
frame hosts keep their existing launch configuration.

A native Vulkan producer can register its Metal layer with
`rsRegisterNativeMetalLayer`. The consumer then encodes the ready texture into
the producer's command buffer, or into a synchronized effects buffer, before
presentation. Registration applies only to that layer, and explicit hosts leave
other Metal layers untouched. Removing a registration drains active encoding
callbacks, while submitted GPU work keeps the lifetime established by its
consumer.

Detailed diagnostics are opt-in. Without a diagnostic output setting, a cached
check finds them disabled and creates no writer thread, timer or output file.
Explicit frame hosts also skip constructor diagnostics and prepared-effect
loading, and actual frame processing initializes the required resources lazily.
When diagnostics are enabled, writing starts after graphics activity, and
hook-installation records stay buffered until then. Writes are bounded and best
effort. Before each write or close, their close-on-exec descriptors are checked
against the owning process and the original regular file.

With diagnostics enabled, the temporal intake also logs its inputs.
`rsProcessTemporalFrame` and the MetalFX scaler hook write one line per frame
for the first 120 frames of the process and for 8 frames after each capture
trigger. A line gives the size, offset and pixel format of the color, depth,
motion, output, exposure, reactive, transparency, HUD-less and UI images, then
the jitter, motion-vector scale, flags, pre-exposure, frame time, camera planes
and field of view, the camera source and the processing status. Each change of a
feature's status or method is also logged at any frame, up to 256 changes per
feature. `rsSetTemporalCameraForNextScale` logs each camera it receives for its
first 120 calls. When a capture trigger is configured, the first frame that sees
a pending request also writes its depth and motion textures beside the capture
prefix as `<prefix>-intake-<frame>-depth.rgba` and
`<prefix>-intake-<frame>-motion.rgba`. These are raw 4-byte texels in the
capture file layout with zero header flags; the depth plane of
`Depth32Float_Stencil8` is written as 32-bit depth. The request itself stays
with the frame capture.

Native warning files use the same ownership checks, together with bounded
nonblocking advisory locking, and invalid or replaced configured files are
dropped. Without a configured warning file, warnings go to private macOS unified
logging instead of the host's standard streams. Constructor success messages
appear only with explicit tracing.

Generated frames are timed against the display. Fixed and adaptive LSFG use the
same bounded delivery plan, in which a single rearmed timer services
interpolation phases between display-link callbacks. Adaptive targets use
display-link refresh feedback, and native view hosts follow their window's
screen. For explicit hosts, live multiplier changes stay within the capacity
selected at launch, whereas automatic hosts rebuild an idle encoder when
capacity or quality changes. The display timing loop starts only when frame
generation is needed. Disabling generation stops that loop and returns to direct
real-frame presentation, while the model is kept for reactivation.

Only one neural producer can be in flight, and overload returns BUSY before
effect or model work is encoded. Accepted neural inputs use consecutive history
identifiers even when game submissions were skipped, although presentation
continues to identify the original game frame and cancellation still invalidates
the model's history. Ordered sessions can switch validated models within their
authorized stores. Producer dimensions can change through an adapter's live
source-control contract, and other adapters keep their original allocation.

A dedicated browser host can publish partial compositor tiles instead of a complete window. When those tiles are not accepted because they do not cover the full window's native extent, completed browser-window frames come from a GPU capture fallback on macOS 14.4 and later. Native surfaces remain the preferred source whenever their extent contract is satisfied. The fallback captures only the current process's selected original window through ScreenCaptureKit, requests BGRA/sRGB SDR frames with a zero minimum interval, and maps IOSurface-backed frames through Core Video into Metal. It introduces no application frame-rate limit, although the capture cadence still depends on the window compositor and display.

This capture is controlled through a per-launch browser channel, which the dedicated host authenticates and maps during library initialization, before the helper is sandboxed. Mapping the channel alone starts no capture or GPU processing. With diagnostics enabled, each process reports one channel initialization result, without its token or path, and when the channel is unavailable, the original window is kept.

A browser slot stays owned through both GPU completion and the queued release. When readiness diagnostics are enabled, they are limited to twelve records during the first five seconds and distinguish encoded frames, GPU completion, physical presentation and child-window visibility.

The original window keeps its input, native controls and fullscreen behavior, while the processed output occupies a separate nonactivating, click-through child window, which independent-window capture excludes. This transparent output child is attached before its first drawable. Its image layer stays hidden until final GPU completion reaches a frame accepted for the current capture geometry, and producer-copy completion alone cannot reveal a frame from an earlier capture geometry. Physical presentation uses its separate drawable callback.

Pending input is bounded and latest-first, and a capture-buffer lease ends after the processor's own GPU copy completes. Capture and Metal resources are created only when the plan demands image processing. Unsupported, transparent or unavailable capture sources keep their original output.

To stay within the device's memory, the processor reserves working-set capacity before it allocates its own images. Active images, pending replacements and retained outputs stay charged against that capacity until their actual GPU or display backing retires. Under allocation pressure, an optional row can be bypassed while compatible later stages continue, and when a complete replacement fails, the accepted graph is kept. Model buffers private to a provider are not estimated as image storage.

SDR output from owned presentation keeps the publisher's nil, sRGB or Display P3 color-space tag, and a nil tag preserves the publisher's existing untagged interpretation. Model stages that require sRGB bypass Display P3 input, while compatible shaders and spatial filters can continue. Unsupported color spaces and extended-range layers keep the original rendering. When the tag changes during play, a separate tagged output is prepared, and the accepted output is kept until its replacement completes.

A terminal command-buffer failure stops processing in the affected presentation. Automatic publishers retry only after the processing or source contract changes, and Off removes the failed owner. With `presentationHoldAbandonAPI: 1`, a presentation hold can also release its cover after restoration, and the `abandoned` status identifies completed restoration of the original rendering. Compatibility surface-copy paths use bounded completion waits, keep borrowed backing until actual completion and discard late results.

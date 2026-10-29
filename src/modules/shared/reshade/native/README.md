# Shared graphics integration

These owned source overrides extend the shared native graphics library. Apply
them to the source revision recorded in `source-overlay.json`; the pinned vendor
checkout stays unchanged. The resulting library retains the existing effects,
scaling, frame generation and native presentation entry points.

`target-time.h` adds optional `rsSubmitFramePresenterAtTime` and
`rsGetFramePresenterTiming` entry points without changing the existing C ABI
structures. Targets use Metal host time in seconds, in the Mach uptime domain.
Targets more than one second ahead are rejected before encoding. At producer
command-buffer scheduling, a future target uses timed presentation; an elapsed target presents
as soon as possible. The original request remains available for timing statistics.
Only positive drawable presentation callbacks count as displayed frames.
`rsSubmitFramePresenterAtTimeObserved` also reports each accepted frame's
retirement, including occluded or dropped output, cancellation and GPU errors.
The callback runs outside presenter locks after GPU use ends. A dropped frame
has no display timestamp, so native buffer fences can retire without counting
that frame as displayed. Existing presentation entry points remain unchanged.
Targeted submission does not support frame generation.
`presentation-observed.h` adds `rsSubmitFramePresenterObserved` for ordinary
display-driven presentation with retirement callbacks and frame generation.
The selected runtime advertises `graphics.observedPresentationAPI: 1`; callers
resolve the symbol before submission. An accepted source frame transfers its
observer context until one final real-display, drop, cancellation or GPU-error
callback. Generated outputs do not retire that source observer. This callback is
independent of the producer-token release callback, and positive presentation
times identify actual real-frame display. Rejection transfers neither context
nor producer-token ownership. ABI1 encoding can leave partial work on a rejected
command buffer, so the caller retains source storage through that buffer's
completion or discard. The caller alone submits the borrowed command buffer.
Ordinary and targeted presentation register when Metal schedules the producer
buffer, without waiting for its GPU work to complete. Discarded buffers and
retired presenters do not issue presentation requests. Scheduling callbacks do
not acquire the producer submission lock, which may be waiting for a drawable.

`native-config.hpp` holds the launch configuration. The library reads its
launch variables from the process environment once, at first use; later
environment changes do not apply. `RESHADE_EXPLICIT_HOST=1` selects an explicit
frame host. A host that loads the library before selecting that mode calls
`rsSetExplicitHost(1, enabled)`, which returns 1 when applied and 0 for an
unsupported version or value. Hooks installed while the library loads follow
the launch environment. With `RESHADE_CAPTURE_TRIGGER`, a utility-queue timer
removes the trigger file within 250 ms and the next frame is captured.
The launch configuration also holds the legacy temporal selection
(`RESHADE_TEMPORAL_*`), diagnostics (`RESHADE_DIAGNOSTICS`, `RESHADE_TRACE`) and
the presentation hold channel (`RESHADE_PRESENTATION_*`). Files named by launch
variables carry commands during the process: live controls and the temporal
control file are read at most ten times per second per thread, and the
presentation hold, browser frame and render-source channels read their files
when they change. The render-source and browser-frame channels read their
variables when used.

`effects-plan.hpp` reads the plan file named by `RESHADE_EFFECT_PLAN`. One
process reader parses each publication once on its own serial queue. A
directory watch observes atomic replacement, a file watch observes in-place
writes, and a two-second timer covers missed events. The first query waits for
the launch plan. Consumers read the published snapshot and its demand with
atomic loads, so a frame performs no file or environment access to check the
plan. A forced poll reads the file on the reader's queue first. A document that
cannot be read, whose envelope is invalid, that has more than 32 rows or that
uses a newer schema is rejected as a whole: the last accepted plan stays
published with the error. Within a readable document each row and the output
block are validated on their own. An invalid or unsupported row stays in place
as a disabled row with its reason; the reader logs it and executions report it
as a bypassed stage. An invalid output block falls back to the default output
settings.

The reader derives the plan's demand once per publication: processing or
pass-through, depth, scene inputs, the scene-frame and attachment masks, frame
generation, the presentation queue, an independent image queue for neural rows
and native-FX-only chains. Producers check it with one load
(`effectPlanDemands`) and do no work for an input the plan does not use. A
disabled or rejected row demands nothing. A layer that the window resolver has
not accepted reads the demand without creating an executor.

Temporal encoders report under their own status context. After each encoded
scene the encoder reports the revision it applied. A presenter that consumes
its output reports that frame's stages under the presenter's context; output
that nothing consumes keeps them under the encoder. An encoder that stops
producing ordered scene output, or whose owner is released, reports Stopped.

A complete build materializes the owned base, these overlays and the pinned
vendor sources, then builds the production CMake targets:

```sh
node scripts/build-graphics-runtime.mjs --only core --work /path/to/work
```

Repeating that command updates only changed files in `core/source`, so CMake
rebuilds only affected units. With `--tests`, the same build directory is
configured with `-DBUILD_TESTING=ON` and `MACLAUNCHER_FIXTURE_DIR` naming
`test/`, and also builds host-architecture fixture executables in
`core/build/test`. Production targets keep the same flags and outputs. The
runner executes every fixture mode and reports fixtures that need a Metal
device as skipped when none is available. Fixtures that need inputs outside
the public sources are skipped with the missing input named, unless these
variables provide it:

| Variable | Input |
| --- | --- |
| `MACLAUNCHER_NATIVE_FIXTURE_LIBRASHADER` | `librashader.dylib` from the graphics runtime |
| `MACLAUNCHER_NATIVE_FIXTURE_LOSSLESS` | A user-supplied Lossless Scaling DLL |
| `MACLAUNCHER_NATIVE_FIXTURE_WINDOWS=1` | Permission to create on-screen windows in an interactive session |

```sh
node src/modules/shared/reshade/native/test/run.mjs /path/to/work/core/build
MACLAUNCHER_NATIVE_FIXTURES=/path/to/work/core/build node --test tests/graphics-native-fixtures.test.js
```

Staging uses this complete build. `build.mjs`
instead rebuilds the owned host units, compiler and video helper against an
existing universal build, such as the `core/build` directory above:

```sh
node src/modules/shared/reshade/native/materialize-source.mjs /path/to/base --base-only
node src/modules/shared/reshade/native/build.mjs \
  /path/to/base /path/to/work/core/build /path/to/output
```

The overlay build recompiles all directly linked native host units and the
owned diagnostics archive together so shared header layouts remain consistent.
Unchanged vendor archives are reused from the existing universal build.

Automatic Metal layer ownership reuses a weak direct view binding. Layer
replacement or view destruction returns to discovery; current window ownership
and dimensions are still checked on every frame. Remote surface discovery uses
a bounded retained ancestor stack without allocating a vector per frame.
Attached full-window IOSurface layers share bitmap layers' bounded local view
ownership and use the shared GPU processors without CPU image conversion.
An initial remote surface can precede its window's context registration. The
adapter retains the latest unchanged source until that context and its extent
are bound, then processes it once. Replacement and context retirement cancel
pending work. Pending sources share the bitmap storage budget, with at most
32 publishers and 64 MiB per surface.

Automatic command-buffer presentation records the requested drawable and encodes
effects immediately before that buffer commits. Applications may request
presentation while an encoder is open, or encode more writes afterward. The
adapter preserves those writes and the original presentation timing. Pending
drawables belong to the command buffer and retire when it commits or is discarded.

On Apple GPUs, attachment-only drawables retain their original `framebufferOnly`
property. Programmable blending copies their final color into a bounded GPU
snapshot on the producer command buffer; ordinary color effects write back
through a render pass, while scaling and frame generation consume the same
snapshot through the shared presenter. The path preserves RGBA8, sRGB and alpha,
uses at most three slots per layer and 256 MiB across layers, and introduces no
CPU readback or completion wait. Renderers that already permit texture access
retain the direct path. Devices without programmable blending retain the
existing readable-drawable path.

The presentation API accepts producer dimensions independently of the output
layer dimensions. With optional spatial processing off, ordinary bilinear
presentation still fits a game's native or dynamic-resolution buffer to the
window; it does not change the producer's requested dimensions.

`source-control.hpp` reads bounded, per-launch JSON commands for an already
active virtual window. Requests use monotonically increasing epochs and exact
launch identities. The main-thread adapter changes source geometry through
the existing window layout path, preserving the fitted output and pointer map.
`virtualSourceFrameReady` acknowledges a request only after a completed producer
frame matches the actual source extent. Windowed Original restoration retains
the proxy until that restored frame completes, then retires the proxy; a later
request can enable it again. Active fullscreen proxies accept source resizing.
Changing between original and virtual windows requires leaving fullscreen.
The two-argument `stopVirtualWindow` checks target identity so retirement of an
old presenter cannot stop its replacement. The original one-argument helper
remains available. Initially-off windows create no controller or polling timer.
Virtual source control requires a renderer view covering the window content.
The renderer declares whether source pixels use backing coordinates or one
pixel per point. Source sizing and completed-frame acknowledgments use that
same contract, including low-resolution OpenGL on Retina displays. An output
being retired retains source readback until its final source frame completes,
even when the source and presentation dimensions have become equal.

Catalyst layer presentation inserts the common output beneath existing UIKit
child layers without replacing their views or input routing. It requires an
opaque Metal source. Resolution multipliers resize the actual game drawable
before allocation; window dimensions remain unchanged.

OpenGL keeps the context profile and acceleration result until its renderer
changes. Transfer paths preserve texture unit zero; native GL effects preserve
all supported shader bindings. Both paths restore the caller's active texture
and rendering state, including distinct legacy front/back polygon modes and when
a frame changes size.

Context destruction removes the adapter's ownership before driver cleanup.
If the context cannot be selected, its GL names are left to native context
destruction while independent Core Video and Metal resources are released.
Cleanup never deletes those GL names through a different current context.

Effects can load PNG lookup textures from the effect folder and
`RESHADE_TEXTURE_PATH` directories. Decoding and GPU upload happen during effect
initialization. R8, RG8 and RGBA8 images retain linear numeric channel values;
sRGB sampling remains an explicit shader choice. Images are bounded to 64 MiB
decoded RGBA data and 256 MiB of texture storage per effect. Shaders requiring
Metal rendering features automatically use the shared Metal processor from
OpenGL through GPU texture interoperation.

The build recompiles the directly linked native host units and diagnostics
archive, and reuses unchanged vendor archives. It rebuilds the changed ReShade compiler
units into `libreshadefx.a` and relinks both `fx-compile` and the runtime library;
the vkd3d shader translator binary is reused. A linked-library plan check verifies
that the parser and temporal reader agree on shader, disabled and temporal rows,
concurrent requests and late shutdown. Build and staging run this check before
accepting the library. Staging includes the applied owned sources alongside the
original pinned vendor sources and notices.

The optional libplacebo provider exposes `rsLibplaceboNodeCompletion` alongside
its ABI-1 factory. After a frame's GPU command buffer completes, offline
processing queries this entry point before accepting the output. Asynchronous
shader failures remain errors even when the provider restores a valid
passthrough image for live presentation. Providers without this completion
entry point require a graphics runtime update for offline processing.

`frame-depth.h` adds optional depth-bearing frame and presenter submissions.
Depth is a borrowed, shader-readable R32Float or Depth32Float texture with the
same source dimensions, device, identity and origin as color. Producer ordering
belongs to the supplied command buffer; a Depth32Float input is sampled into
R32Float on the GPU. These APIs preserve raw depth and do not infer projection
parameters. Existing color-only structures and entry points are unchanged.

The Metal processor supports up to eight pass color attachments and effect-owned
stencil testing, including read/write masks, comparisons and operations. The
effect stencil is cleared at its first use in each frame and reused by later
full-extent passes; it is separate from the game's depth attachment. Automatic
Metal capture associates only stored depth with the presented color in the same
command buffer, and invalidates that association when encoder store actions
change. OpenGL capture uses compatible default-window depth. Remote color
surfaces and hosts that do not submit depth retain their color-only contract.

Compute passes use the shader's declared threadgroup size and dispatch counts.
Sampled textures, samplers and writable 2D storage views bind through the compiled
Metal resource indices. Storage mip levels share the original texture, preserve
history between frames and reset on resize. Compute and render passes use the
same command buffer with tracked resource dependencies; no CPU pixel transfer
is required. Integer, normalized, packed RGB10A2/RG11B10 and floating-point
formats map to their corresponding Metal formats. Compilation checks texture
dimensions against the selected Metal device’s limits.

ReShadeFX accepts readable RGBA16Float, RGB10A2Unorm and BGR10A2Unorm color frames
and preserves their range and alpha through format-matched passes. Hardware sRGB texture views and
sRGB render writes require compatible 8-bit formats. PNG frame capture accepts
RGBA8 and BGRA8 frames; other color formats continue processing without PNG
readback. Owned presentation overlays use SDR BGRA8 output and do not inherit
the source layer's HDR metadata. Extended dynamic range Metal layers retain
their original presentation; compatible FX can process their original drawable
in place. Neural rendering retains its SDR 8-bit contract.
Automatic Metal processing retries rejected images when their device, format,
extent or framebuffer access changes. Identical rejected images retain original
rendering without repeating shader preparation.

The compiler accepts Windows separators in shader include paths and `exists`
checks without altering ordinary string literals. Legacy texture offset and
gather names use ReShade's original compatibility aliases and sampling operators.
The preprocessor adaptation retains its BSD-3-Clause header and records the exact
vendor source hash in `source-overlay.json`. Full source builds select the same
adaptation through the owned `CMakeLists.txt`.

The builder’s optional `--compiler-only` argument produces the shader compiler
without rebuilding the native presentation library.

`uniform-sources.hpp` supplies per-effect timer, frame time, typed frame count,
ping-pong animation, bounded random and local date uniforms. Annotation lookup
happens after compilation; animation advances once per frame, shared by every
pass. Each effect owner retains its own state. Image sources accept PNG, JPEG,
BMP and the first frame of GIF files, and resize to the shader's declared
dimensions during loading. Matching lookup images keep their original samples.
Compressed and decoded images have separate bounded size checks.

Metal effect initialization reuses immutable shader libraries for the same
device object, exact generated source and default compile options. The shared
cache retains at most 128 libraries and 32 MiB of source text. Concurrent requests
for an admitted source share its compilation, while unrelated cached sources
remain available. Failed compilations are not retained. Pipelines, uniforms,
animation state, samplers and textures remain separate for each effect owner.

The launcher publishes live controls as an atomically replaced 19,116-byte
`MLFXCTL2` packet. It contains bounded graphics settings, effect identity and
revision hashes, and up to 128 scalar/vector uniforms. Native readers validate
the packet and poll at most ten times per second per producer. Shader, uniform and
presenter readers share a thread-local snapshot. Unchanged files skip payload
reads, and unchanged selections reuse cached configuration without allocation.

`graphics.presentationHoldAPI: 1` coordinates a renderer change with a shared
effect change while an existing, visible opaque SDR view overlay remains on
screen. Version 1 supports ordinary owned overlays as both source and
destination; it does not create an overlay for an all-off or in-place source,
remove presentation, or transfer virtual/Catalyst output. Independent renderer
and shared-effect updates retain their separate live paths.

The launch binds `RESHADE_PRESENTATION_CONTROL_FILE`,
`RESHADE_PRESENTATION_STATUS_FILE`, `RESHADE_PRESENTATION_LAUNCH_ID` and
`RESHADE_PRESENTATION_TOKEN`. Sibling files are named
`presentation-control-<launchId>.json` and `presentation-status-<launchId>.json`.
Bounded schema-1 commands contain launch/token identity, increasing `epoch`,
`transactionId`, `action`, and `expected: {planRevision, controlsDigest}`. The
digest covers the complete exact `MLFXCTL2` packet. `hold` also requires
`candidate: {planRevision, controlsDigest, requiresPresentation: true}`.

`hold` drains issued drawables before reporting `held`. After renderer options
and shared publication agree, `present` arms a matching producer frame; `cancel`
arms the original contract after rollback. `presenting` confirms admission is
armed so a paused renderer can request a redraw. `presented` and `cancelled`
require a positive actual drawable display timestamp and drained presentation
work. The image remains frozen through these acknowledgments. A final durable
`finish` command resumes continuous output and reports `finished`. Stop removes
the output regardless of transaction state. Every status includes `holding`,
which reports whether an owned display lease remains active, including after a
failed update. Native input-contract changes reset
reconstruction and generation history, including otherwise identical shared
plans. An idle channel allocates no additional image or model resources.

Flag bit 5 selects effects after spatial scaling; the default applies effects
before scaling. `RESHADE_EFFECT_PLACEMENT=after` provides the same choice for a
launch configuration. After-scaling effects use the scaled image directly as
their first color input and run at output resolution. Depth effects require
before-scaling placement when the image is resized, so color and depth keep
matching dimensions. Temporal
reconstruction remains in the game renderer, and LSFG receives the completed
effect/scaling output. Changing placement invalidates LSFG history.

`RESHADE_LIVE_EFFECTS` identifies a per-game directory of immutable preprocessed
effects and their declared image inputs. The launcher validates each revision
before publishing it. Metal and OpenGL create replacement effect resources before
retiring the previous pipeline. Source-based uniforms remain runtime controlled.
Explicit frame hosts retain their existing launch configuration.

Native Vulkan producers can register their Metal layer with
`rsRegisterNativeMetalLayer`. The consumer encodes the ready texture into the
producer's command buffer or a synchronized effects buffer before presentation.
Registration is scoped to that layer; explicit hosts leave other Metal layers
untouched. Removal drains active encoding callbacks, while submitted GPU work
retains the lifetime established by its consumer.

Detailed diagnostics are opt-in. Without a diagnostic output setting, their
cached disabled check creates no writer thread, timer or output file. Explicit
frame hosts skip constructor diagnostics and prepared-effect loading; actual
frame processing initializes the required resources lazily. Enabled diagnostic
writes start after graphics activity; hook-installation records stay buffered
until then. Writes are bounded and best effort. Their close-on-exec descriptors are checked
against the owning process and original regular file before writing or closing.
Native warning files use the same ownership checks and bounded nonblocking
advisory locking. Invalid or replaced configured files are dropped. Without a
configured warning file, warnings use private macOS unified logging rather than
host standard streams. Constructor success messages require explicit tracing.

Fixed and adaptive LSFG use the same bounded delivery plan. A single rearmed
timer services interpolation phases between display-link callbacks. Only one
neural producer can be in flight; overload returns BUSY before effect/model work
is encoded. Accepted neural inputs use consecutive history identifiers even
when game submissions were skipped. Presentation continues to identify the
original game frame. Cancellation still invalidates the model's history.
Adaptive targets use display-link refresh feedback, and native view hosts follow
their window's screen. Live multiplier changes stay within the capacity selected
at launch for explicit hosts. Automatic hosts rebuild an idle encoder when
capacity or quality changes. Ordered sessions can switch validated models within
their authorized stores. Producer dimensions can change through an adapter's
live source-control contract; other adapters retain their original allocation.
The display timing loop starts only when frame generation is needed. Disabling
generation stops that loop and returns to direct real-frame presentation while
retaining the model for reactivation.

Completed browser-window frames use a GPU capture fallback on macOS 14.4 and later when a dedicated browser host publishes partial compositor tiles that fail full-window native extent admission. Existing native ingress remains preferred when its extent contract is satisfied. The fallback captures only the current process's selected original window through ScreenCaptureKit, requests BGRA/sRGB SDR frames with a zero minimum interval, and maps IOSurface-backed frames through Core Video into Metal. It introduces no application frame-rate limit. Capture cadence still depends on the window compositor and display.

The dedicated host authenticates and maps its per-launch browser channel during library initialization, before helper sandboxing. The mapping alone starts no capture or GPU processing. Enabled diagnostics report one channel initialization result per process without its token or path; unavailable channels retain the original window.

Browser slot ownership extends through both GPU completion and queued release. Enabled readiness diagnostics are bounded to twelve records during the first five seconds and distinguish encoded frames, GPU completion, physical presentation and child-window visibility.
The transparent output child is attached before its first drawable; its image layer remains hidden until final GPU completion reaches a frame accepted for the current capture geometry. Producer-copy completion alone cannot reveal a frame from an earlier capture geometry. Physical presentation uses its separate drawable callback.

The original window retains input, its native controls and fullscreen behavior. Processed output occupies a separate nonactivating, click-through child window; independent-window capture excludes that child. Pending input is bounded and latest-first, and capture-buffer leases end after an owned GPU copy completes. Capture and Metal resources are created only for active image-processing demand. Unsupported, transparent or unavailable capture sources retain their original output. Native test executables are excluded from the default build; `-DBUILD_TESTING=ON` enables their targets.

Owned image allocations reserve device working-set capacity before allocation. Active images, pending replacements and retained outputs remain charged until their actual GPU or display backing retires. Allocation pressure can bypass an optional row while preserving compatible later stages; a failed complete replacement retains the accepted graph. Provider-private model buffers are not estimated as image storage.

Owned SDR output retains a publisher's nil, sRGB or Display P3 color-space tag. A nil tag preserves the publisher's existing untagged interpretation. Model stages that require sRGB bypass Display P3 input; compatible shaders and spatial filters can continue. Unsupported color spaces and extended-range layers retain original rendering. Live tag changes prepare a separate tagged output while retaining the accepted output until its replacement completes.

Terminal command-buffer failure stops processing in the affected presentation. Automatic publishers retry only after a changed processing or source contract, and Off removes the failed owner. A presentation hold can release its cover after restoration through `presentationHoldAbandonAPI: 1`; the `abandoned` status identifies completed restoration of original rendering. Compatibility surface-copy paths use bounded completion waits, retain borrowed backing through actual completion, and discard late results.

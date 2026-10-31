# Frame sources and runtime adapters

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

A runtime connects to MacLauncher's graphics processor through a frame adapter. The adapter hands each completed image to the processor, together with any matching scene data the renderer supplies. Graphics support follows the frame producer, the code that actually renders the frames, not the game type or the CPU architecture, and runtime or CPU names never select separate effect implementations.

This page describes each frame source and scene producer, the module contract for launching a game with graphics, renderer input declarations, attachment hosts and completed-window capture. [Renderer integrations](SHARED_PROCESSING.md) describes which runtimes supply scene data and render-size control.

[Frame sources and scene inputs](#frame-sources-and-scene-inputs) · [Module launch entry points](#module-launch-entry-points) · [Renderer input declarations](#renderer-input-declarations) · [Attachment hosts and CPU architecture](#attachment-hosts-and-cpu-architecture) · [Completed-window capture](#completed-window-capture) · [Picked windows and displays](#picked-windows-and-displays)

## Frame sources and scene inputs

A runtime's `graphicsHost` declaration selects an attachment contract. It does not identify the frame source that the game actually uses while rendering. A Java game, for example, can present an OpenGL framebuffer, a Metal drawable or a software bitmap. Wine can present Metal through a Direct3D translator, or OpenGL through WineD3D. These routes use the same adapters as native applications.

The shared image pipeline receives completed color images. A frame source can be direct access to the render target, an operating-system window stream, a texture the runtime supplies, or an upload of a software image:

| Frame source | Attachment and GPU handoff | Scene data this route supplies |
| --- | --- | --- |
| Native Metal drawable | `metal.mm` intercepts the selected drawable and its command buffer. Eligible size-preserving FX can run in place, and other chains use owned presentation, in which the processor presents the output itself. This route also covers Metal output from Java and from Wine translators. | Matching depth from a supported render pass, when requested. A Metal drawable alone supplies no motion vectors, jitter or camera projection. |
| Hardware OpenGL framebuffer | `opengl.mm` and `opengl-interop.mm` receive the game's flush, copy its framebuffer into CoreVideo/IOSurface GPU images and submit Metal processing. This includes compatible Java OpenGL and WineD3D output. | Matching default-framebuffer depth, when present and requested. No game motion vectors, jitter or camera projection are inferred. |
| Core Animation surface | `window.mm` and `layer-presentation.mm` receive published IOSurfaces or supported layer images. The adapter accepts only a full image of the selected window, because a compositor tile is not a complete frame. | Composed color only. |
| Completed software bitmap | A supported `CGImage` layer publication, or a complete bitmap drawn during the selected view's `drawRect:`, is uploaded to a reusable IOSurface. Later effects run on the GPU. | Color and image geometry only. The software producer's original pixels are already in CPU memory. |
| Browser window stream | Dedicated Electron and NW.js hosts can use `browser-frame.mm` when native compositor surfaces do not provide the complete window. ScreenCaptureKit supplies the selected window's composed image, and CoreVideo and GPU copies hand it to the shared processor. | Composed color only, with no renderer depth or motion vectors. |
| Picked window or display | `window-source.mm`, driven by the `maclauncher-graphics-window` helper, captures a window or display chosen in the macOS content picker and presents the processed image in an overlay window above it. | Composed color only, at the window's pixel size, with no source-resolution control, depth or motion vectors. |
| Explicit runtime textures | A runtime calls `rsProcessFrame`, its depth variant or the presenter API with its own Metal textures and synchronization. Android presentation integrations use this contract. | Color, plus only the matching inputs that the producer explicitly supplies. A graphics host declaration alone adds no scene data. |
| Native mpv processing | mpv applies compatible shader prefixes and scaling to its decoded video, with the original video planes and decoder color metadata. Shared effects after that prefix receive the RGB image mpv produced, through the player's actual Metal or OpenGL frame adapter. | The original video planes belong to the mpv prefix. Later shared effects get composed RGB, with no game depth or motion vectors. |
| Decoded GPU video host | `video/native/mpv-render.mm` keeps decoded GPU surfaces and submits them to the shared graph before window fitting. Paused redraws keep the content identity. | Decoder color and format metadata and the source PTS; no game scene data. |
| Offline video frames | `video-frame.mm` and `graphics-video.mm` import decoded sample buffers as GPU textures for the shared frame API and pass the completed output to the encoder. | Decoded color and media timestamps; no game scene inputs. |

### Presented extent

Owned presentation keeps the source layer's mapping of image to bounds. When a Metal drawable's or Core Animation surface's layer stretches the whole image over its bounds (resize gravity, the full contents rectangle and centered), the output is presented at the view's backing size. Any other mapping, such as Java's top-left drawable that is taller than its view, is presented at the producer's own image size with the same gravity, contents rectangles, contents scale and orientation. Processing therefore never rescales the image or shows pixels that the original layer clips. When the drawable's resolution is reduced, the presented size stays at the size the producer requested.

### Window capture

Two frame sources capture with ScreenCaptureKit. The browser window stream is turned on through the authenticated per-launch channel that `shared/web/runtime/browser-graphics.js` creates for dedicated browser hosts; a `graphicsHost: "window"` declaration does not open that channel for arbitrary Java, Wine or native applications. A [picked window or display](#picked-windows-and-displays) is captured only after a choice in the macOS content picker. ScreenCaptureKit shows the macOS sharing indicator while its stream is active. Direct Metal and OpenGL interception does not use that stream. GPU texture copies on either route involve no CPU pixel readback and no recording files. [Completed-window capture](#completed-window-capture) describes the stream itself.

### Color and alpha

Color shaders, processing of derived luma and chroma, resize rows and compatible image-based neural effects all use the common color contract. Frame generation from color pairs also needs consecutive images and an owned presentation timeline. Their image processing can therefore be shared across producers.

Opacity belongs to the producer's frame contract. Opaque display images keep all RGB pixels even when their stored alpha is unused or zero. Transparent images keep their declared straight or premultiplied alpha through compatible filters, including libplacebo processing. The selected model or provider still sets its own color, format and platform requirements. Original subsampled decoder planes stay distinct from luma and chroma derived from a composed RGB image.

### Scene producers

Scene effects have a separate input boundary. A scene producer supplies the renderer data for one scene frame:

| Scene producer | Supplied data | Processing boundary |
| --- | --- | --- |
| Original MetalFX temporal call | The actual color, depth, motion, jitter and output of the intercepted scaler call; camera data only when supplied separately. | A record from the same command buffer ties the original scene to its exact output. Replacing the scaler in an ordered chain also requires the supported acquired-drawable output contract. |
| Godot renderer integration | The helper registers the actual projection and renderer resources, and the matching original MetalFX call supplies its command buffer and jitter. | The bridge hands that matched scene to the shared processor. Registering metadata alone creates no scene producer for another renderer. An ordinary window attachment keeps its frame-adapter inputs. |
| Streamline through the DXMT bridge | The game's actual tagged resources and supplied camera and projection constants. | The API adapter translates the game's scene request and keeps its resources for each context. The native reconstruction method that runs is reported separately from the API the game called. |
| XeSS D3D11 through the DXMT bridge | The game's actual color, depth, motion, jitter and exposure. The XeSS interface itself supplies no camera projection. | Compatible requests enter the MetalFX producer and the shared ordered scene boundary. The native method that runs is independent of the API the game called, and methods that need projection data need a producer of that data. |
| Explicit temporal frame API | The caller's matching textures, camera and scale data, flags, frame identity and command buffer. | `rsProcessTemporalFrame` validates the selected provider's actual inputs. |

The D3D11 Streamline adapter copies `OnlyValidNow` input tags on the owning GPU context before the original tag call returns. These snapshots keep the exact region, format and frame identity through evaluation and GPU completion. Longer-lived tags keep their original resources. When optional shared processing cannot get the resources it needs, both DXMT routes keep the original SDK call and its output.

Compatible in-game XeSS D3D11 translation is selected independently of optional shared postprocessing. When postprocessing is off, it keeps the original game DLL and the game's base upscaling. D3D12 and Vulkan translation needs a translator that exposes matching textures and command insertion, and those game routes keep their original libraries. In-game XeSS API translation is a renderer compatibility feature, and it reports which Mac reconstruction algorithm actually runs.

An engine adapter produces data; it does not decide which effects are eligible. Godot's scene supplier attaches to viewports in the native window, while offscreen viewports keep their own compositor and scaling. The shared completed-image path stays available, and a matching scene frame from another producer can use the same compatible reconstruction or generation provider. [Godot](SHARED_PROCESSING.md#godot) describes the user-facing behavior. Depth-only filters, scene reconstruction and scene generation each declare their own required inputs. Camera matrices, exposure, reactive masks and HUD-free color are separate optional or required resources for each operation, and temporal inputs are separate from other renderer inputs such as normals, albedo and lighting buffers.

### XeSS compute hosts

The scene producer and the algorithm that runs are separate choices. Intel XeSS is a temporal upscaling implementation in the shared graph, and the game's CPU architecture and original upscaling API do not decide whether it can run. [XeSS](PROVIDERS.md#xess) lists its inputs and host routes.

The D3D12 implementation runs the unmodified Intel runtime in an isolated compatible compute host. Metal GPU commands hand the scene over through shared images and aliased D3D12 buffers, and the launcher carries only setup metadata. Backend selection is part of the row's XeSS Options.

- The launcher watches for compute-host setup requests only while a prepared plan has an enabled XeSS row or one of its hosts is still running.
- When a live update is rolled back, the watch state of the plan that keeps running is restored. A plan with an XeSS row keeps the watch, and a plan without one stops it at once when no host is running.
- Launch preparation and live edits each register their XeSS hosts and bind them to the running process. The host table written for the launch keeps every route and names its latest registration, and each setup request is claimed exactly once, by the registration its route names.

### Depth

Depth alone allows compatible depth shaders but does not make temporal upscaling possible. Window framebuffer depth, drawable depth and explicit depth images carry no camera projection, so they are copied only for rows that read depth alone. Image filters that unproject depth need a projection from the renderer; without one, they are bypassed with the reason that the frame source supplies no camera projection.

Depth images have the same orientation as their color image and keep the renderer's depth range and encoding. ReShade `.fx` rows interpret reversed, logarithmic or rescaled depth through the game's [depth-input definitions](EFFECT_PLANS.md#depth-input).

Scene frame generation has its own depth, motion, camera and history requirements. Flow or motion that an image-pair generator or a neural model estimates from the images, including the motion field of MetalFX image interpolation, is never passed on as game motion vectors. Generated color frames do not gain matching renderer guides just by keeping the source frame's identifier.

### Source size

Changing the game's render size is separate from processing. Downsampling after rendering changes the submitted image. Engine controls or the virtual-source protocol can change the producer's allocation, but only after the producer acknowledges the requested size. Neither window-stream dimensions nor the final output fit show that the game renders to a smaller target. [Game render allocation](FRAME_API.md#game-render-allocation-and-processing-extent) describes the source strategies.

## Module launch entry points

A runtime entry declares its `graphicsHost` in module metadata. The launcher prepares the shared processor through `context.getGameEffectsEnvironment()`, and `context.applyGameEnvironment(base)` combines that environment with the game's existing environment. Engine-specific renderer selection stays in the module.

The library UI and `scripts/run-game.mjs` both launch through `createLauncher().launchEntry`, and direct module hosts get the same game context from `getGameLaunchContext(entry, settings, options)`. Action contexts use `getLaunchContext` and leave game effects off. The game context handles lazy preparation, runtime graphics metadata, merging the selected libraries and the final process handoff. A module may replace the context's graphics getter with the scoped environment its sandbox produces before it calls `spawnDetachedChecked`. Callers never prepare or merge a second graphics environment.

### Code-signature check

Before the final native handoff attaches the shared processor, it checks the executable's code-signature policy. When a restriction is confirmed, the game runs without the attachment and its launch binding records the reason. If the game's plan needs processing and a registered module offers a `captureCompanion(library)`, a [capture companion](#capture-companion) processes a copy of the game's window instead. An executable whose signing facts are unknown stays eligible. A launch transport can supply `graphicsExecutable` with its actual executable, or `null` when the descendant process is unknown; this metadata is read before the process is created. Rosetta wrapping happens after the check.

### Process adapters

An optional `processAdapter(command, args, options, needsRosetta, spawn)` wraps the final handoff for inherited instrumentation. The `spawn` continuation it receives keeps the selected graphics environment, network policy and process ownership. Component callers can supply `graphicsRuntimeRoot` for verified preparation assets and `presentationLibrary` for the processor library to call. Ordinary launches use the included selection.

### Diagnostics

Four boolean `graphicsDiagnostics` fields (`diagnostics`, `capture`, `gpuTiming`, `trace`) configure the same preparation path without changing the saved plan. Detailed diagnostics, GPU timing and frame capture are opt-in:

- When a graphics package declares `features.graphics.screenshotAPI: 1` and diagnostic capture is off, a live launch configures the same frame capture channel in its final-image mode (`RESHADE_CAPTURE_FINAL=1`) for processed screenshots. That mode reads back only the final processed image of one requested frame, before the performance overlay is drawn, and never attaches processing by itself, so an idle or Off game keeps its dormant path. Frame capture writes 8-bit images. When the final image has another format, such as RGBA16Float, a 10-bit format, PQ or HLG, it is converted once with the output color encoder to 8-bit sRGB at the image's reference white. The shared presenter converts its drawable, which is described by the output color, and in-place processing converts the game's target, which is described by the game's image color. The conversion applies the Automatic output mapping, which compresses content above that white when the output can hold it. The launch record holds the channel as `screenshotCapture`. A runtime sandbox that moves the capture prefix and request file into its writable folder rewrites `screenshotCapture` in the launch record to the moved paths. The launcher writes the request file named there, waits up to five seconds for the image, moves it to the screenshot folder and removes every file the capture staged.

- Disabled diagnostic entry points read cached enable flags and create no recorder state, writer thread, output file or GPU query.
- Enabled recorders use fixed-size queues, and render callbacks drop records rather than wait for a writer lock.
- Diagnostic file writes verify process and file ownership and stop on failure. They are independent of source acknowledgments and graphics control metadata.

Failures of warning and informational notifications, including rejected asynchronous notifications, are contained separately from preparation and live updates. Rendering never waits for these notifications.

### Native prefix routing

A module can export an optional asynchronous `prepareEffectsEntry(entry, context)` hook, which returns the entry that shared processing uses. The hook keeps the supplied entry and removes only the work that the original renderer performs. The launcher passes it to effect preparation as `options.prepareEffectsEntry`, and uses `context.effectsEntry` for the same selection at launch. Main-process validation, live controls and shared plan preparation work on the resulting runtime entry, while the saved game keeps its complete settings and plan. Runtime-specific routing stays in the module. The video module uses this hook for [native video prefixes](SHADERS_AND_MEDIA.md#native-video-prefixes).

## Renderer input declarations

A module may export `resolveGraphicsInputs(entry, context)` to describe the selected renderer's inputs and native controls. The inspector shows the same metadata with runtime status. Status reads use installed metadata and never start a renderer or use the network.

| Field | Meaning |
| --- | --- |
| `nativeVideo` | The renderer supplies decoded video planes. |
| `nativeSpatialMethods`, `nativeSpatialMethodLabels` | The original renderer's filter registry. |
| `sourceResolution` | `false`, or an explicit capability object with `heights` and `multipliers`. Its `control` can identify a source adapter owned by the engine, and the optional `methods` and `methodLabels` list the source renderer's scaling filters and their display names. |
| `shaderBindingsNextLaunch`, `spatialBindingsNextLaunch` | Settings that are bound when the process starts. |
| `architecture` | The actual architecture, when it depends on the selected runtime. See [CPU architecture](#cpu-architecture). |

Source sizing uses explicit heights or divisors, and explicit frame producers keep the divisors they advertise. Native window adapters without a `sourceResolution` declaration keep the producer's allocation unless an included virtual-window adapter is advertised. `features.graphics.virtualWindowAPI: 1` exposes `GraphicsCapabilities.virtualWindow` and its supported source factors to the window host. Explicit source declarations take precedence, and `sourceResolution: false` and native video leave out the virtual-window fallback. The UI reads these capabilities and never assumes that an arbitrary drawable can be resized.

Simple neural processing starts with a 540-pixel input height. An available source adapter may apply that height before completed-frame processing, and smaller natural inputs keep their size. The `virtualSourceAutoAPI` and `automatic: true` source protocol stay compatible with older prepared consumers, but they add no Automatic choice to Downsample. Historical automatic graph extents become an explicit 540-pixel height, so the editor and execution use the same dimensions.

## Attachment hosts and CPU architecture

| Host | Frame source | Ownership |
| --- | --- | --- |
| `window` | Supported native Metal, hardware OpenGL, Core Animation and completed Quartz bitmap frames | The adapter selects the game window and holds its source until GPU reads finish. |
| `remote` | Hosted browser surfaces | The producer supplies its surface and presentation timing. |
| `explicit` | Metal textures supplied by the runtime | The runtime controls ordering, frame identity and submission. |
| `catalyst` | Supported iOS application Metal layers | The adapter preserves the drawable and application lifecycle. |

The host's renderer connects through its declared presentation adapter. Inspection and extraction tools run independently of presentation hosts.

### CPU architecture

Rosetta changes the instruction set of the process that loads the graphics core, not the frame source. An x86_64 Wine or Java process can use the same Metal or OpenGL adapters as an ARM64 process. Neural execution that only exists for ARM64 goes through the GPU helper, and MetalFX availability follows the actual device, OS and framework support. None of these declarations is a list of allowed renderers for each game.

Optional `graphicsArchitecture` metadata names a fixed host architecture, `arm64` or `x86_64`. It describes the process that loads the graphics library, which can be a translated Intel host. Renderer input metadata can supply the actual `architecture` when it depends on the selected runtime. Provider architecture checks use this value, never an engine name.

- A native app bundle without recorded executable metadata resolves its declared bundle executable before its Mach-O slices are inspected.
- Explicit renderer and runtime architecture declarations take precedence, and the architecture of a script stays unspecified when it is unknown.
- A scripted launcher can pass `{needsRosetta: true}` to `context.getGameEffectsEnvironment` or `context.applyGameEnvironment` before it prepares the child environment. This selects the Intel graphics contract for the actual translated executable, including optional provider validation.
- Changing the architecture after the game process is bound is rejected.

### Bitmap and OpenGL lifetime

Metal adapters hold GPU textures directly, and hardware OpenGL adapters use the shared texture and surface bridge. For supported layers that publish `CGImage` contents, each completed software image is uploaded into a reusable IOSurface pool of fixed size, and shader passes and intermediate images then stay on the GPU. A bitmap image carries color, dimensions and timing but no scene depth or game motion vectors.

The Quartz adapter can also keep a full bitmap published during the selected content view's original `drawRect:` call and submit it after drawing finishes. Individual drawing calls and dirty rectangles are not complete frames. Direct Quartz drawing that does not publish through a supported frame adapter is outside that adapter's contract.

When an OpenGL context is retired, graphics ownership is removed before driver cleanup is attempted. An unavailable context leaves its GL objects to native destruction, and independent host resources are released without choosing another context for deletion.

## Completed-window capture

A completed-window adapter captures the selected original window when native ingress supplies only incomplete compositor surfaces. Its capture core, `window-stream.mm`, also serves [picked windows and displays](#picked-windows-and-displays). It uses an independent ScreenCaptureKit window source, GPU texture copies and the shared processor, and on macOS 14.4 and later it can capture in the background. Capture starts only while processing is active and does not need the game in front. Producer throttling can still limit how many fresh source frames arrive. A browser helper whose sandbox refuses the effects plan path accepts no native full-window surface, so the completed-window adapter in the launcher-side process, which reads every edit, processes that window.

Capture is limited to the game window:

- macOS shows its screen-sharing indicator while the capture is active.
- The capture filter includes the selected game window and excludes child windows. Audio capture is off.
- Frames stay in local processing buffers. Ordinary playback has no network transport and no recording file; explicit diagnostic capture can save local before and after images.
- On macOS 14.4 and later, the current process's windows are listed through Apple's consent-free API rather than broad desktop access. The indicator still shows an active capture stream.
- Turning off graphics processing or closing the game stops the capture session.

Capture errors keep the original renderer and release the failed session. A settled stream whose complete images keep a different size or pixel format from the configured window for one second counts as a recoverable capture error. Configuration changes are serialized and coalesced to the latest window geometry. A temporary failure gets a limited number of recovery attempts before the original window returns, and obsolete callbacks cannot replace a newer configuration.

For Electron windows hosted by the launcher, an in-process visibility notification keeps source animations running while the processed output is visible. Covering, minimizing, disabling or closing that output restores the previous background throttling policy. The game keeps control of its own frame timing.

GPU completion and physical presentation have separate callbacks, so covered output can complete processing without a positive drawable `presentedTime`. The opt-in `FrameCapture` records the original and final pixels of one accepted source frame after its GPU work completes successfully.

## Picked windows and displays

Window graphics apply a graphics chain to another app's window or to a display. [Window entries](../game-types/WINDOW.md) describes the menus, the session lifecycle and the saved per-app chains; this section covers the frame path.

The `window` module's `capture` runtime starts the `maclauncher-graphics-window` helper as the session's process. The helper loads the graphics library, declares itself an explicit host and calls the window source ABI in `window-source.h` (`rsWindowSourceAPI` 1). The runtime entry keeps `graphicsHost: "window"` for its capabilities, such as live switching and adaptive generation, and adds `explicitFrames: true`, so preparation sets the explicit host and installs no load-time hooks. Live edits, the effects plan, live controls and status use the ordinary launch binding of the session's entry.

The source extends the [completed-window adapter](#completed-window-capture): the same `window-stream.mm` core supplies stream configuration, serialized geometry changes, bounded recovery, GPU slots and the shared presenter, so color effects, scaling methods and image-pair frame generation apply. The frame source is reported as `external-window`. The module's renderer input declaration is `{source: "window-capture", sourceResolution: false, depth: false, motionVectors: false}`, so source-resolution candidates and scene-input options are absent.

The picker supplies the content filter. A window filter includes the window's child windows. A display filter is rebuilt from shareable content so that it excludes the helper's own windows, because the overlay would otherwise appear in its own capture; building it needs the Screen & System Audio Recording permission.

The overlay is a borderless, nonactivating panel at the floating window level that never becomes key. Its content view hosts a container layer that holds the presenter's Metal layer. Each poll, ten times a second, reads the target's bounds, owner, layer and on-screen state from window-server metadata, which needs no permission. The presenter's layer stays hidden until the first accepted frame at a new size, and the overlay hides while the target is off screen or minimized, and while the session is suspended for sleep, screen sleep or a user switch. The flag `RS_WINDOW_SOURCE_SCALED` selects one of two placements for a window; a display is always in place:

- In place, the overlay ignores the pointer and covers the target in points, and the drawable uses the source's pixel extent at the target's display scale. It hides while another process's window covers the target.
- Scaled output covers the target's screen: the visible frame, or the whole screen when the target's bounds equal it. The presenter's layer is the largest centered rectangle with the target's aspect ratio, on whole points, and the bars show black once a frame is shown. The drawable is that rectangle at the screen's backing scale, so the presenter enlarges the source with the plan's spatial method. The overlay shows only while the target's process is the frontmost app and none of that process's own windows covers the target.

In Scaled output, the overlay accepts pointer events, including the first click, and a tracking area delivers pointer movement. Each mouse, drag, scroll and movement event on the image is mapped to the matching point in the target's window-server bounds, then copied with that location and with the target window set as the window under the pointer, and posted to the target's process with `CGEventPostToPid`. Points on the bars are dropped, and drags and releases are clamped to the image edge. Keyboard events need no forwarding, because the panel never takes key status from the active app. Posting events needs the Accessibility permission: the launcher asks for it when Scaled is chosen and keeps In place while it is missing, and the helper checks it again with `CGPreflightPostEventAccess` before it sets the flag.

Capture runs only while processing is requested. Off stops the stream and keeps the filter, so turning processing back on needs no new pick. **Include pointer in capture** sets the stream's `showsCursor`. A change to it or to **Output** restarts the stream with the same filter. The plan's [frame-rate cap](FRAME_API.md#source-frame-rate-cap) (`output.frameRateCap`) limits capture: a frame arriving sooner than 0.75 of the cap's interval after the previous accepted frame is dropped.

The helper reports session events as JSON lines on standard output, which the launcher writes to its main log, plus a heartbeat each second. A session that produces neither a heartbeat nor other output for more than five seconds is ended. Option lines such as `{"cursor":true,"scaled":false}` arrive on standard input, and the end of standard input stops the session. When Scaled output is requested without the Accessibility permission, the helper keeps the window in place and reports `{"event":"output","output":"in-place"}` with the reason.

### Capture companion

A library game whose code signature does not allow the graphics library to load can still be processed when its plan needs processing and the installed graphics runtime reports window graphics. After the game's process starts, the launcher starts the helper with the launch's prepared graphics environment, the explicit host and `--owner-only`. The helper waits up to 120 seconds for the process's first layer-0 window, opens the picker for it, and accepts only a window that the game's process owns. The game's launch binding keeps the game's process; it records `graphicsAttachment: {available: true, captured: true}` with a warning, so live edits and status continue. The companion stops when the game exits.

### Output under resource pressure

During temporary resource pressure, in-place Metal and OpenGL effects reuse only an image whose GPU work has completed and which matches the current settings and output contract. Sustained pressure switches to the original rendering until that contract changes, so processed and untreated frames never alternate. OpenGL reuses its fixed set of interop slots without waiting for command scheduling. None of this adds a window wrapper or a cap on the source frame rate.

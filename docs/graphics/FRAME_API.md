# Frame, presentation and source-sizing APIs

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

A runtime or engine adapter uses these interfaces to hand frames to MacLauncher's graphics processor, supply matching scene data, request a render size and present the result. The headers in `src/modules/shared/reshade/native/` define the versioned C structures.

Three terms recur on this page. A *producer* is the code that renders frames and hands them to the processor: a game's renderer, a video decoder or a runtime that submits its own textures. *Scene guides* are the renderer data that matches a frame, such as depth, motion, jitter and camera parameters. *Publishing* a plan makes a prepared effects plan the one the running game uses. Image handoff, scene guides, source allocation and output presentation are separate contracts, and every compatible producer uses the same GPU execution path.

[Borrowed frames and owned presentation](#borrowed-frames-and-owned-presentation) · [Scene frames and matching guides](#scene-frames-and-matching-guides) · [Color, alpha and time domains](#color-alpha-and-time-domains) · [Geometry reuse and drawable lifetime](#geometry-reuse-and-drawable-lifetime) · [Game render allocation and processing extent](#game-render-allocation-and-processing-extent) · [Live source commands and virtual windows](#live-source-commands-and-virtual-windows)

## Borrowed frames and owned presentation

A color frame carries its source and destination dimensions, Metal device, origin, color representation, frame identity and time. A consumer must never treat an unrelated texture, or a later command buffer, as matching scene data.

### Borrowed command buffers

`rsProcessFrame` encodes processing into a borrowed Metal command buffer. `rsProcessFrameWithDepth` adds a matching depth texture. The caller submits the command buffer itself and must keep the textures alive until the GPU completes. Encoding neither commits nor waits for the borrowed command buffer.

`rsProcessFrameWithDepth` and `rsSubmitFramePresenterWithDepth` accept R32Float or Depth32Float depth textures with the color frame's device, dimensions, identity and origin. Depth32Float is converted on the GPU.

Shader working resources are tied to their source geometry, pixel format, Metal device and producer queue. When the device or queue changes, a replacement is created before the next input is copied, and resources that were already encoded stay retained until their command buffer completes. Spatial scaler caches follow the same queue and device rule, including requests that only scale. Replacements keep the caller's source and presentation texture dimensions and pixel formats.

### Owned presentation

In owned presentation, the processor presents the output itself. `rsCreateFramePresenter` and `rsSubmitFramePresenter` provide this display-driven presentation, and their depth and explicit-timing variants keep the corresponding input contracts. `rsDestroyFramePresenter` shuts down the presenter and ends the work it started. A native Metal producer can register a layer with `rsRegisterNativeMetalLayer`, use the matching source lease, and unregister the layer before releasing its callback context.

Ordinary submission uses the caller's command buffer. A private Metal queue is created only for detached neural work, paced frame generation or retained replay. If a frame-generation queue or display timing is unavailable, generation is bypassed and compatible processing continues on the caller's buffer. The failure is remembered for the unchanged selection, and the next accepted control or plan change can retry. Stop ends display timing and the presenter's own work without releasing images the GPU is still using.

### Observed presentation

`rsSubmitFramePresenterObserved` adds display-driven retirement callbacks and keeps ordinary frame generation. It requires the selected runtime's `graphics.observedPresentationAPI: 1` capability or a successful symbol lookup.

After a successful submission, the observer context is held until exactly one final callback: real display, drop, cancellation or GPU error. Generated frames do not trigger the source observer's final callback, and releasing the producer token is independent of it. A positive presentation timestamp records the actual display of the real frame. When a frame is rejected, the caller keeps both contexts. ABI 1 submissions can encode partial work before rejecting a frame, so the source storage must stay valid until that command buffer completes or is discarded. Submitting the command buffer remains the caller's job, and a submission with an explicit target time keeps its strict timing contract and excludes frame generation.

### Inputs for each kind of processing

Color, CRT, sharpening and spatial filtering process the submitted color image at its dimensions. Neural reconstruction adds its selected model, estimated flow and the history its provider keeps. LSFG uses its selected model with opaque color images and display-driven presentation. Its HDR path converts to linear BT.709/scRGB with an 80-nit reference white and uses the original HDR generation kernel before returning to the source encoding.

Scene-dependent processing needs more:

- Depth shaders use matching scene depth together with color.
- Renderer temporal upscaling uses matching depth, motion and jitter, plus the camera data the selected provider needs.

LSFG's own image-based motion estimation does not supply game motion vectors to other effects, and a neural model's estimated flow also stays private to its provider. Renderer temporal inputs are accepted only through their renderer integration or the temporal frame API. Unsupported or mismatched inputs leave the original frame unchanged and report the processing reason.

## Scene frames and matching guides

### Temporal frames

The [temporal frame header](../../src/modules/shared/reshade/temporal/frame.h) defines `RSTemporalFrame`. It holds the owner, the borrowed commands, the color, depth, motion and output textures, the render and output sizes, independent texture offsets, jitter, motion scale, pre-exposure, frame identity, timing and optional guides. Motion maps current pixels to previous pixels after its declared scale is applied. Flags identify reversed or infinite depth, output-resolution or jittered motion, and perspective camera metadata. `rsProcessTemporalFrame` validates this contract and dispatches the selected provider; it does not commit the caller's command buffer.

`rsGetSceneFrameDemand(1)` reports the inputs the enabled graph requires without preparing GPU resources. The plan reader derives them once per plan update, and the call reads them with one atomic load. Perspective near, far and field of view are declared separately from view and projection matrices, so a producer can supply color, depth and motion without describing a perspective camera. `rsBindTemporalSceneMatrices` copies the transforms for the exact owner, frame, commands and texture tuple. The texture-registration forms support producers that record before the commands exist; each frame boundary and producer retirement clears stale registrations.

### Scene matrices

`RSSceneMatrices` ABI 1 has a 152-byte layout. Its matrices are row-major, row-vector world-to-view and view-to-clip transforms. Separate flags declare valid view and projection data, a zero-to-one or minus-one-to-one clip depth, a projection that already includes jitter, and downward NDC Y. Providers that unproject through the projection also require a known clip convention. The producer declares matrix orientation and jitter representation; a frame's origin does not imply them. A depth-only Image filter can require depth and projection without motion or a separate perspective near, far and field-of-view declaration.

### Guide normalization

A shared encoder, `SceneGuideEncoder`, normalizes consumed regions and known resize geometry. The requirements of each prepared node select the depth, motion, masks and exposure it needs, including output-resolution motion conventions. Available guides that no node consumes are retained without GPU conversion. Guide leases keep the transformed textures and camera metadata alive until GPU completion, including suffix work on another command buffer. Generated images and unknown coordinate warps do not supply replacement renderer guides.

The original guide coordinates are kept separate from the current processing image, so a paused live edit can request another input. Whether an attachment applies to the current image is tracked independently: an upstream HUD pair cannot become valid again merely because its source resources are still retained.

### Scene AOVs and HUD pairs

`RSSceneAovs`, in the [AOV header](../../src/modules/shared/reshade/temporal/scene-aovs.h), is a versioned companion to the temporal frame. It carries real normal and roughness, material reflectance, resolved or noisy lighting, hit distance, masks, metallic, and HUD and UI attachments. Each image declares its region, encoding, origin and capture pass. The frame and view, epoch, image revision, pre-exposure and color metadata identify the exact tuple. Lit specular is distinct from material specular reflectance. A missing attachment stays absent. An observed registration transfers one retirement callback, which fires once all accepted GPU and replay use has ended.

HUD-less color and UI color and alpha form an atomic pair, each with its own color description. If a pair is missing, stale or misaligned, processing uses the complete composed image. The shared layer never infers foreground or HUD masks. MetalFX interpolation normalizes the declared color, alpha and origin of a complete, aligned, separate UI attachment on the GPU before it uses the SDK's separate-UI mode. Unsupported separate regions or synchronization keep the complete composed-image route.

### Scene copy boundaries and Metal 4 recordings

`rsSetTemporalSceneCopyBoundary` registers an exact immutable scene snapshot and engine target. Recording is allowed only through the identity copy and the blit encoder that ends it. Optional work that is not ready leaves the original copy and the later renderer passes unchanged. Producer-specific capture belongs at the renderer boundary, and shader bindings and algorithms consume this common companion.

With `metal4SceneAPI: 1`, native MetalFX SDK spatial, temporal, denoised and interpolation recordings can enter the same graph through the Metal 4 recording bridge. The bridge observes the SDK factory that takes the compiler, the recording, the queue and the commit options. Shared classic Metal work uses GPU events between the original Metal 4 segments, and feedback keeps the producer queue's ordering and affinity. An unknown submission contract leaves the original SDK recording unchanged. The borrowed classic frame APIs above keep their existing command-buffer types.

A consumer that owns its exact event can omit redundant original SDK GPU work after its replacement is published successfully. Native history, direct window continuation and later producer operations keep the original work when their ownership requires it. A pending drawable resumes on its existing recording worker after publication and keeps producer order. Resource information does not create a new presentation timeline or allow an unprocessed frame between processed deliveries.

A midpoint generated by the SDK is marked as generated, and the depth, motion and material images of its closing real endpoint do not describe it. Compatible image processing stays available for the midpoint, but scene-dependent rows need matching scene data, and another pair operation needs a complete pair and timeline. Exact frame, view and epoch metadata, together with GPU-signaled records of each processed target, keep the ordinary presenter from applying the same leading effects twice.

### Window continuation

With `sceneWindowContinuationAPI: 1`, a cooperating producer can register the native destination window for its exact scene tuple. The common presentation path binds that window, waits on a GPU producer event and runs only the rest of the graph on the final composed color. The binding identifies one final image; texture dimensions or window titles never establish which window it belongs to. Subviewports and ambiguous compositions need their own explicit destination contract. Declaring an HDR source does not depend on optional perspective metadata.

### Temporal provider ABI

Temporal provider ABI 1 keeps a separate history owner and a method bitmask. An optional `rsPrepareTemporalResources` symbol builds resources without encoding, consuming content IDs or advancing history. Existing providers without that symbol keep the compatible path, which prepares disposable resources.

## Color, alpha and time domains

### Color descriptions

`RSImageColorDescription` describes the actual RGB primaries (BT.709, Display P3 or BT.2020), the transfer function (sRGB, linear, PQ, HLG or camera BT.709), range, alpha, reference white, luminance limits and whether the image is scene-referred or display-referred. Explicit color metadata accompanies `rsProcessFrameWithColor`, `rsProcessTemporalFrameColor` and the color-aware presenter and video entry points. In the temporal ABI, the legacy HDR flag means linear BT.709 with 1.0 at 203 nits and a nominal 1000-nit peak; explicit metadata supplies a more specific contract.

The GPU color encoder handles transfer, gamut, range, exposure, alpha and output quantization. A provider that requires bounded sRGB receives a local SDR conversion, and unrelated graph rows keep their source description and precision. Tone mapping into that local conversion changes highlight information and does not make an SDR model an HDR model. The final output conversion uses the target color description and display headroom.

The FSR 2, FSR 3, FSR 4, ASR and SGSR2 temporal ABI 1 providers receive a local linear BT.709, full-range, straight-alpha domain with a 203-nit reference white. Where a provider consumes a supplied exposure texture, its value is multiplied by `203 / sourceWhite` to compensate for the RGB unit conversion, and the pre-exposure itself stays unchanged. Results return to the source color domain, including its transparent alpha. Canonical opaque RGBA16F input and output skip the redundant color and alpha passes. These local conversions do not tone map the source or change what the scene guides mean.

### Output tone mapping

A plan's saved `output.toneMapping` policy selects Automatic, Preserve (shown as **None** in the editor), Reinhard or PBR Neutral for the final conversion. Preserve disables final range compression. PBR Neutral requires scene-referred metadata and an image that has not already been mapped for display; otherwise, the final encoder uses Automatic and reports the reason. Comparison maps both sides with the same selected mapping before comparing them, followed by one final encoding and quantization dither.

### Alpha

Final game frames are opaque by default when display metadata is absent. A producer's explicit transparent value is kept through preparation, processing and presentation. Neural processing normalizes alpha in its private opaque model input and restores the source alpha in the result, leaving the source texture unchanged. Pixel alpha and declared display opacity are separate parts of the frame contract.

### Timing

The origin, color mode, matching depth, frame ID and available source timing stay attached to the same image as stages run. The basic `rsProcessFrame` ABI carries the frame ID, color and origin; when it supplies no timestamp, shader timing uses the local processing clock. The timestamped presenter and offline video interfaces keep their source timing. Captured source timestamps and durations stay attached through asynchronous preparation, publication and same-frame readiness, and a later callback never replaces them with its own arrival time. The processed color, origin and attachment applicability describe the current image independently of the retained source timing and origin.

Presenter source times use monotonic host seconds compatible with `CACurrentMediaTime`, while offline frame times use the source media timeline in milliseconds, so the two interfaces have separate time origins. The original libplacebo renderer keeps its own clock for hook frames.

Presenter cadence keeps measured source periods above 240 Hz. An explicit source rate accepts any finite value of at least 1 Hz, with no upper limit, and zero selects observed timestamps. Long source interruptions keep interpolation timing within fixed limits, and none of these timing calculations throttle the renderer.

### Frame generation order

With frame generation, the prefix processes each accepted real source image once. Generation keeps the image dimensions produced by the stage before it. In Advanced, a scaler before frame generation changes its working size, and a scaler after it processes each delivered real or generated image. Final fitting maps the completed chain to the native presentation size, separately from the generation working size.

Completed source images establish the interpolation period, so slower neural processing does not pace generated images from rejected renderer submissions. Each batch keeps that period, its exact chain and the source frame identity. Suffix effects run on each delivered real or generated image with a separate output sequence and presentation-phase time. Generated images receive no fabricated game depth or motion. The declared origin stays attached through processing, and the presenter applies its configured final orientation once.

### Background neural processing

In ordinary native presentation, independent neural processing keeps one source snapshot on the game's command buffer and processes it on an owned queue after the producer completes. It does not submit the game's buffer or make the next game submission wait for the worker. While the worker is busy, the previous complete processed output stays visible. Neural temporal history, scene temporal inputs, frame generation, and explicit presentation targets or observers keep their execution in producer order. Resizing discards queued work whose dimensions no longer match. Work already scheduled on the GPU can complete, and its resources stay retained until it does.

### Hidden windows

Native view hosts cache the occlusion state of the output window on the main thread. While that output is hidden, the shared presenter pauses new processing and display phases not yet issued, and keeps the last complete processed image and the GPU resources it has already accepted. When the window becomes visible, processing resumes through the existing producer and delivery clock, with fresh interpolation history instead of the old queued phases. An inactive but visible window keeps processing. When visibility is unknown, processing continues normally. Virtual-window activation keeps replaying its initial completed image until physical presentation is established.

## Geometry reuse and drawable lifetime

Native shader reuse includes the output scale and presentation-relative sizing in the key that identifies each resource, and each row also keeps its own input and output image contract. When the final drawable is resized, stages sized from the source whose working dimensions do not change keep their state, while stages sized from the presentation, and the affected stages after them, prepare separate state. Rejecting a later row leaves the accepted shader and its history intact.

Drawable delivery reserves a ticket before calling the Metal presentation driver. The driver call runs outside the presenter's state mutex, so a presentation callback can read state without waiting on its own caller. A ticket is released only after the driver call has returned and the drawable's presentation or failure callback has completed. Held transitions include these tickets in their drain barrier, and the geometry snapshots that the barrier uses are read before the state mutex is acquired. Presenter layer snapshots keep their ownership under that mutex. Stop detaches the layer under the same lock and releases it outside teardown locks. Layer properties and driver calls stay outside the state lock, so callbacks can reenter safely.

Owned presentation counts the drawables of its output layer that are acquired, queued or displayed. A displayed drawable counts until a later one replaces it, and a dropped or unpresented drawable stops counting when it is released. At the layer's maximum drawable count, a frame skips presentation without requesting another drawable, because that request would block the submitting thread for up to one second. A presenter logs once when refusals continue for two seconds.

## Game render allocation and processing extent

The size fields of effect rows control intermediate processing targets, independently of the game's render-target allocation. The `renderResolution` field of a plan controls source allocation separately. The game render texture, each effect target and the presentation drawable are three separate sizes. Drawable dimensions use physical backing pixels, not window points. Each row's factor applies to the output of the row before it, and doubling width and height gives four times as many pixels.

### Source requests

`renderResolution` takes these values:

| Value | Source request |
| --- | --- |
| `null` or missing | Keep the game's render size. |
| `{ multiplier: 1 \| 1.5 \| 2 \| 3 \| 4 }` | Divide both presentation dimensions by the multiplier. |
| `{ height: n }` | An integer height from 1 to 16384, preserving the presentation aspect ratio. |
| `{ height: 480, maximum: true }` | A maximum height rather than an exact one, also clamped to the producer's original source size. |

Requested source dimensions stay within the physical presentation dimensions. Existing explicit plans can keep the maximum-height form, and manual height selections in Advanced use the exact-height form. The v0.4.0 Simple field `entry.graphics.spatialMultiplier` is upgraded into a `renderResolution` multiplier once, when the record is read, so it keeps its meaning as a source-allocation request.

Either source object can also store `method`, which selects one of the adapter's advertised source filters. Omitting it keeps the game's original filter. This selection is independent of spatial effect rows; the Godot adapter uses it for scene scaling before interface composition. A producer that declares `filterExclusiveWithTemporal` disables source-filter overrides while a temporal node is enabled, and the original filter stays selectable. Other producers keep their own filtering contract. Source preparation passes the selected method to its adapter in `RESHADE_RENDER_SOURCE_METHOD`.

### Source strategies

Source control requires an explicit engine or producer contract. Source requests from both Simple and Advanced prefer a compatible renderer API, then eligible virtual source sizing. When neither is available, compatible ordered chains run a GPU Downsample stage before their other effects.

The Godot adapter is a renderer API. It adjusts its 3D render scale while keeping the original drawable and 2D rendering. This requires the selected engine helper's `sourceResolutionAPI: 1` and an active non-XR root 3D viewport that uses Forward+ or Mobile. The engine scale is limited to `0.1` through `2`, and divisor and maximum-height requests keep a game-selected scale that is already lower. Explicit producers expose their supported divisors through the existing allocation contract. Other frame adapters keep the source their producer supplies, and native video processing keeps the decoded source dimensions.

Accepted requests and native capabilities are separate. A divisor of 4, for example, uses completed-frame Downsample when no source adapter supports that allocation. An allocation request can also include the Downsample reduction as a guard for a renderer that rejects the request after creating its viewport. When the source already meets the target, the reduction skips filtering and allocates no intermediate image. Divisor targets stay relative to the current presentation, and height targets preserve the input aspect ratio and never enlarge the image. This fallback reduces processing work while game rendering keeps its allocation. Temporal, depth and motion inputs prevent a reduction that would invalidate their geometry.

Launch records and logs keep the requested source, the selected strategy and the reason. During a live source change, a rejected renderer acknowledgment restores the accepted plan and source before one processing fallback attempt. Restoring the original allocation is also an acknowledged source operation, and a failed restoration is reported.

### Launch environment

Source allocation is bound at launch through these environment variables, independently of the selected spatial method:

| Variable | Meaning |
| --- | --- |
| `RESHADE_RENDER_HEIGHT` | An exact source height. |
| `RESHADE_RENDER_MULTIPLIER` | A source divisor. |
| `RESHADE_RENDER_MAX_HEIGHT` | A maximum source height. |
| `RESHADE_RENDER_SOURCE_METHOD` | The selected source filter, for the adapter that owns the source. |
| `RESHADE_RENDER_SOURCE_CONTROL` | `drawable` for a cooperating producer that opts in to drawable source control; `virtual` for a [virtual window](#virtual-windows). |
| `RESHADE_RESOLUTION_MULTIPLIER` | The legacy Simple spatial-method contract. |

These variables alone do not allow resizing arbitrary Metal drawables. Generic drawable source control is off unless a producer opts in with `RESHADE_RENDER_SOURCE_CONTROL=drawable`. Engine source adapters adjust offscreen rendering through the renderer's own scale settings. The presentation view keeps the native window geometry, backing scale, display selection and fullscreen behavior.

### Resizing and window content

During resizing, a presentation that is already shown keeps its last completed processed image fitted to the current content bounds while replacement targets are prepared. Queued output is checked against the current drawable dimensions before encoding and scheduling, so obsolete output never replaces the resized image. Automatic frame ownership is limited to the window's content-view subtree; the title bar, toolbar and other window chrome stay outside game processing. Ordinary output presentation stays inside the bounds of the game content.

### Virtual windows

A native window host that advertises `virtualWindowAPI: 1` can use `RESHADE_RENDER_SOURCE_CONTROL=virtual` for a requested source reduction when no renderer allocation API is available. The game is then presented in an ordinary resizable native output window, while the original renderer and responder stay in the source window.

- Resizing the output window adjusts the source content size. The fitted image rectangle also defines absolute pointer mapping, and relative mouse deltas keep their original values. Native title bar controls and resize borders stay outside the mapped game image.
- The source window accompanies the output window into its fullscreen Space. Minimizing suspends both windows, and stopping restores the source window.
- The output window keeps the original content size limits and aspect ratio or resize increments, in window points. The processing scale does not scale those constraints.
- A failed fullscreen transition reconciles the current geometry and releases the transition state. A prepared replacement that has not yet taken ownership leaves fullscreen requests with the original native window.

Games that size their interface from the window dimensions can change their interface layout in this mode, and a scene-renderer adapter can keep interface composition at native resolution. Virtual presentation is created only when the source size changes, and native video and hosts that disable source control keep their original allocation. No display mode change or fixed screen resolution is needed. Each completed frame carries its current source and destination sizes, so earlier backing dimensions never define a later frame's allocation.

## Live source commands and virtual windows

### Live source API

Renderer source adapters can also advertise `sourceResolution.live`, and the inspector preserves this capability for its source controls. During play, the live source help follows the current launch's source binding, not a capability declared by another process or an earlier session.

The launcher API has two steps:

- `source-controls.prepare(entry, {userDataDir, support, launchId, source})` creates a separate command and status channel for a launch and returns its environment and binding. Unsupported adapters get no channel, and a null source leaves an unmodified game allocation alone.
- `stage(source, {binding, publication, signal, isCurrent})` stages an atomic command with a higher epoch after the effect plan, and returns `wait()` and `rollback()`.

After `publication.commit()`, `wait()` checks for the exact launch, epoch and revision in the renderer's applied result. An unchanged non-null request also requires its current applied result. An unchanged Original request neither waits nor publishes a new command, and a valid existing result returns immediately.

On failure, callers first roll back the publication and then await the source transaction's `rollback()`. Source rollback publishes the previous settings at a higher epoch, because renderers reject older commands. A `false` result means the transaction no longer controls the source; a continuing session reports the failed restoration and keeps the newer command. The engine adapter keeps its last accepted source on malformed or stale input and restores only the properties it still controls. The Godot adapter provides this live source API with the versioned helper, and other adapters keep their declared allocation contract.

A successful source acknowledgment includes finite applied pixel dimensions, or a finite scale with viewport dimensions. Virtual source acknowledgments also include the observed completed producer size, which matches the applied width and height; window geometry alone does not acknowledge a rendered source.

### Virtual source channels

A graphics core that declares `virtualSourceControlAPI: 1` extends this protocol to a virtual window requested at launch. `virtualSourceActivationAPI: 1` also allows a metadata-only null source for launches that start with effects off or at 1×. The existing native window poll reads this channel only while processing, activation or source restoration is needed. An untouched Off state creates no source reader, virtual window, capture, model or GPU work.

A core that declares `virtualSourceChannelAPI: 1` can reserve a second, dormant virtual channel beside a native engine or drawable channel. The launch record's `sourceControls` maps each control to its binding, and `sourceControl` keeps the primary binding for older consumers. The dedicated virtual binding uses `RESHADE_VIRTUAL_SOURCE_CONTROL_FILE`, `RESHADE_VIRTUAL_SOURCE_STATUS_FILE`, `RESHADE_VIRTUAL_SOURCE_LAUNCH_ID` and `RESHADE_VIRTUAL_SOURCE_ACTIVATION_API`. Its files end in `<launchId>-virtual.json` and have independent epochs and the same launch identity.

A native source failure excludes that control for the current update. The update then tries virtual allocation, and finally completed-frame downsampling. Before moving the allocation to a different control, the update restores the previous control's original allocation and waits for its exact acknowledgment inside the renderer transaction. A failed replacement restores both the accepted graph and the source. An already active compatible control stays preferred for later edits. These channels carry prepared control metadata and add no work to frame nodes.

### Virtual window activation

A live activation prepares output while keeping the original source window's geometry and input. Its first completed image is retained with the same frame identity, and replaying it does not rerun effects or generation. Visible activation waits for a positive presentation callback before changing the source geometry. When both windows stay covered on the active Space, a completed opaque image can support background activation without taking focus. That image stays retained for replay once the window is visible; GPU completion is never reported as physical display. Hidden, minimized or transitioning windows defer activation. A slow first neural image has a limited preparation wait, and cancelling keeps the original.

An applied reduction waits for an acknowledgment that matches the completed source. A producer already at the requested pixel size reports `virtual: false` without creating a proxy. The acknowledgment includes the source and presentation pixel dimensions, and a later resize invalidates it until another matching frame completes. An existing proxy accepts live height and divisor changes, including in fullscreen, and keeps its completed image while the source is reallocated. Applied results report the observed producer size.

In windowed mode, a null or full-size source restores the original window once its restored frame completes, and the same launch can enable the virtual source again later. Enabling or removing a virtual window requires leaving fullscreen. Pointer gestures finish before their source coordinate map changes, and invalid or stale commands leave the accepted source in place.

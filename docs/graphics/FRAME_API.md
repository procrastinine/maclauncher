# Frame, presentation and source-sizing APIs

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

This page describes the native interfaces that connect a runtime or engine adapter to MacLauncher's graphics processor. Through them, an adapter hands over frames, supplies matching scene data, requests a render size and presents the result. The versioned C structures are defined in the headers in `src/modules/shared/reshade/native/`.

Three terms recur on this page. A *producer* is the code that renders frames and hands them to the processor: a game's renderer, a video decoder or a runtime that submits its own textures. *Scene guides* are the renderer data that matches a frame, such as depth, motion, jitter and camera parameters. *Publishing* a plan makes a prepared effects plan the one the running game uses. Image handoff, scene guides, source allocation and output presentation are separate contracts, although every compatible producer uses the same GPU execution path.

[Borrowed frames and owned presentation](#borrowed-frames-and-owned-presentation) · [Scene frames and matching guides](#scene-frames-and-matching-guides) · [Color, alpha and time domains](#color-alpha-and-time-domains) · [Geometry reuse and drawable lifetime](#geometry-reuse-and-drawable-lifetime) · [Game render allocation and processing extent](#game-render-allocation-and-processing-extent) · [Live source commands and virtual windows](#live-source-commands-and-virtual-windows)

## Borrowed frames and owned presentation

A producer can hand a frame to the processor in two ways. With a borrowed command buffer, processing is encoded into the producer's own buffer; with owned presentation, the processor also presents the result. Either way, a color frame carries its source and destination dimensions, Metal device, origin, color representation, frame identity and time. A consumer must never treat an unrelated texture, or a later command buffer, as matching scene data.

### Borrowed command buffers

`rsProcessFrame` encodes processing into a Metal command buffer that the caller lends to it, and `rsProcessFrameWithDepth` also takes a matching depth texture. Encoding neither commits nor waits for the borrowed command buffer, so the caller submits the buffer itself and must keep the textures alive until the GPU completes.

Both `rsProcessFrameWithDepth` and `rsSubmitFramePresenterWithDepth` accept R32Float or Depth32Float depth textures with the color frame's device, dimensions, identity and origin. Depth32Float is converted on the GPU.

The working resources of a shader are tied to its source geometry, pixel format, Metal device and producer queue. When the device or queue changes, a replacement is created before the next input is copied, while resources that were already encoded stay retained until their command buffer completes. A replacement keeps the caller's source and presentation texture dimensions and pixel formats. Spatial scaler caches follow the same queue and device rule, including requests that only scale.

### Owned presentation

In owned presentation, the processor presents the output itself, with display-driven timing. `rsCreateFramePresenter` and `rsSubmitFramePresenter` provide this presentation, and their depth and explicit-timing variants keep the corresponding input contracts. `rsDestroyFramePresenter` shuts down the presenter and ends the work it started. A native Metal producer can also register a layer with `rsRegisterNativeMetalLayer` and use the matching source lease; it unregisters the layer before it releases its callback context.

Even so, ordinary submission uses the caller's command buffer. A private Metal queue is created only for detached neural work, paced frame generation or retained replay. If a frame-generation queue or display timing is unavailable, generation is bypassed and compatible processing continues on the caller's buffer. This failure is remembered while the selection stays unchanged, and the next accepted control or plan change can retry. Stopping the presenter ends display timing and the presenter's own work without releasing images that the GPU is still using.

### Presentation options

Two plan options control how the presenter's own output layer shows processed images. `output.displaySync` sets the layer's display sync (`displaySyncEnabled`), and `output.drawableCount` sets its maximum number of drawables, 2 or 3. When an option is unset, the layer keeps the value it had when the presenter was created. These options apply only to the presenter's output layer and never to the game's layer. In a window, the compositor presents every image at the display refresh, so turning display sync off lowers latency only in fullscreen, where it can also cause tearing. A graphics package that supports these options declares `features.graphics.presentationOptionsAPI: 1`.

### Performance overlay

The performance overlay shows frame rates, timing, memory and frame counters over the processed image. It is selected with `output.hud`: `off` (the default), `compact` or `detailed`. Because the shared presenter draws the overlay into the drawable after the final fit, color conversion, comparison and subframe stages, every frame source that uses owned presentation shows it. Frame capture and retained replay images, however, are taken before the overlay is drawn and never contain it.

The overlay's text is rasterized with Core Text at most four times per second on a utility queue, and each presented image composites the latest raster with one blended draw at the top left of the output. Overlay white is the SDR reference white of the output's transfer function, including PQ and HLG outputs. If the overlay cannot be prepared, it is disabled for that presenter and presentation continues unchanged. A graphics package that includes the overlay declares `features.graphics.performanceHudAPI: 1`, and [status and delivery](STATUS_AND_DELIVERY.md#performance-overlay-counters) lists its counters.

### Observed presentation

A producer that needs to know what happened to each frame can submit it with `rsSubmitFramePresenterObserved`. This call adds display-driven retirement callbacks and keeps ordinary frame generation. It requires the selected runtime's `graphics.observedPresentationAPI: 1` capability or a successful symbol lookup.

After a successful submission, the observer context is held until exactly one final callback, which reports real display, drop, cancellation or GPU error. A positive presentation timestamp records the actual display of the real frame. Generated frames do not trigger the source observer's final callback, and releasing the producer token is independent of it.

When a frame is rejected, the caller keeps both contexts. However, ABI 1 submissions can encode partial work before they reject a frame, so the source storage must stay valid until that command buffer completes or is discarded. The caller still submits the command buffer itself. A submission with an explicit target time but no [content stamp](#timing) keeps its strict timing contract and excludes frame generation.

### Inputs for each kind of processing

What a producer must supply depends on the processing. Color, CRT, sharpening and spatial filtering process the submitted color image at its dimensions. Neural reconstruction adds its selected model, estimated flow and the history its provider keeps, and LSFG uses its selected model with opaque color images and display-driven presentation. For HDR input, LSFG converts to linear BT.709/scRGB with an 80-nit reference white and uses the original HDR generation kernel before returning to the source encoding.

Scene-dependent processing needs more:

- Depth shaders use matching scene depth together with color.
- Renderer temporal upscaling uses matching depth, motion and jitter, plus the camera data the selected provider needs.

Motion estimated from the images never stands in for these inputs. LSFG's own image-based motion estimation does not supply game motion vectors to other effects, and a neural model's estimated flow also stays private to its provider. Renderer temporal inputs are accepted only through their renderer integration or the temporal frame API. When inputs are unsupported or mismatched, the original frame is left unchanged and the processing reason is reported.

## Scene frames and matching guides

Processing that depends on the scene receives a color image together with the scene guides that match it.

### Temporal frames

The [temporal frame header](../../src/modules/shared/reshade/temporal/frame.h) defines the main structure for this, `RSTemporalFrame`. It holds the owner, the borrowed commands, the color, depth, motion and output textures, the render and output sizes, independent texture offsets, jitter, motion scale, pre-exposure, frame identity, timing and optional guides. Motion maps current pixels to previous pixels after its declared scale is applied, and flags identify reversed or infinite depth, output-resolution or jittered motion, and perspective camera metadata. A frame is processed with `rsProcessTemporalFrame`, which validates this contract and dispatches the selected provider; it does not commit the caller's command buffer. When a selected method other than MetalFX Temporal does not encode the frame, the call encodes it with MetalFX Temporal instead and the result names the method that encoded, as [Failures while running](LIVE_UPDATES.md#failures-while-running) describes. The direct provider and preparation interfaces keep the selected provider's own status.

Vulkan translators enter this boundary through a frame description rather than through a driver-specific upscaler. NGX evaluations from vkd3d-proton, or from DXVK through `IDXGIVkInteropDevice`, carry `VkTemporalFrameInfoMVK` to MacLauncher KosmicKrisp or a MoltenVK build with temporal-carrier support. These drivers forward Super Resolution color, depth, motion, output, exposure and scaling values to `rsProcessTemporalFrame` in queue order on a classic Metal command buffer. Their tracked output texture holds the complete result before it is copied to the game's output region. Optional camera parameters come from Streamline constants; the consumers do not forward the carrier's HUD-less/UI or Ray Reconstruction attachments. [Scene producers](INPUTS_AND_ADAPTERS.md#dlss-through-vulkan-translators) describes the routes and their input conventions.

A producer can first ask which inputs the enabled graph requires. `rsGetSceneFrameDemand(1)` reports them without preparing GPU resources: the plan reader derives them once per plan update, and the call reads them with one atomic load.

Camera data is optional. Perspective near, far and field of view are declared separately from view and projection matrices, so a producer can supply color, depth and motion without describing a perspective camera. When a producer does supply matrices, `rsBindTemporalSceneMatrices` copies the transforms for the exact owner, frame, commands and texture tuple. The texture-registration forms support producers that record before the commands exist, and each frame boundary and producer retirement clears stale registrations.

For D3DMetal, a camera-only handoff through the `maclauncher-temporal-camera` builtin uses `rsSetTemporalCameraForNextScale` and `rsClearTemporalCameraForNextScale`, declared in the [camera header](../../src/modules/shared/reshade/temporal/camera.h). One process-scoped slot is consumed by the next application scaler encode, while exact scaler/command or texture bindings take priority. A collision discards the fallback camera, stale frame IDs are rejected, and presentation clears the slot for the next frame. This fallback adds only Streamline's actual camera parameters and optional frame duration; the native scaler call still supplies every scene texture, jitter, motion-vector scale, exposure and reset value.

### Scene matrices

These transforms are passed in `RSSceneMatrices`, whose ABI 1 layout is 152 bytes. Its matrices are row-major, row-vector world-to-view and view-to-clip transforms. Separate flags declare valid view and projection data, a zero-to-one or minus-one-to-one clip depth, a projection that already includes jitter, and downward NDC Y. The producer declares matrix orientation and jitter representation, because a frame's origin does not imply them. Providers that unproject through the projection also require a known clip convention. A depth-only Image filter, on the other hand, can require depth and projection without motion or a separate perspective near, far and field-of-view declaration.

### Guide normalization

Earlier rows can crop or resize the image, so the scene guides have to follow the image that each row actually receives. A shared encoder, `SceneGuideEncoder`, normalizes consumed regions and known resize geometry. The requirements of each prepared node select the depth, motion, masks and exposure it needs, including output-resolution motion conventions, while available guides that no node consumes are retained without GPU conversion. Guide leases keep the transformed textures and camera metadata alive until GPU completion, including suffix work on another command buffer. Generated images and unknown coordinate warps, however, do not supply replacement renderer guides.

The original guide coordinates are kept separate from the current processing image, so a paused live edit can request another input. Whether an attachment applies to the current image is tracked independently: an upstream HUD pair cannot become valid again merely because its source resources are still retained.

### Scene AOVs and HUD pairs

A producer can also supply additional renderer images, known as AOVs (arbitrary output variables). They are carried by `RSSceneAovs`, a versioned companion to the temporal frame that the [AOV header](../../src/modules/shared/reshade/temporal/scene-aovs.h) defines. It carries real normal and roughness, material reflectance, resolved or noisy lighting, hit distance, masks, metallic, and HUD and UI attachments. Each image declares its region, encoding, origin and capture pass, and the frame and view, epoch, image revision, pre-exposure and color metadata identify the exact tuple. Lit specular is distinct from material specular reflectance. A missing attachment stays absent. An observed registration transfers one retirement callback, which fires once all accepted GPU and replay use has ended.

A HUD pair lets processing treat the game's interface separately from the scene. HUD-less color and UI color and alpha form an atomic pair, each with its own color description. If a pair is missing, stale or misaligned, processing uses the complete composed image instead, and the shared layer never infers foreground or HUD masks. MetalFX interpolation, for example, normalizes the declared color, alpha and origin of a complete, aligned, separate UI attachment on the GPU before it uses the SDK's separate-UI mode. When separate regions or their synchronization are unsupported, it keeps the complete composed-image route.

### Scene copy boundaries and Metal 4 recordings

A producer can mark the point where its scene is copied with `rsSetTemporalSceneCopyBoundary`, which registers an exact immutable scene snapshot and engine target. Recording is then allowed only through the identity copy and the blit encoder that ends it. If optional work is not ready, the original copy and the later renderer passes stay unchanged. Producer-specific capture belongs at this renderer boundary, while shader bindings and algorithms consume the common companion.

Native MetalFX SDK recordings can enter the same graph as well. With `metal4SceneAPI: 1`, spatial, temporal, denoised and interpolation recordings pass through the Metal 4 recording bridge, which observes the SDK factory that takes the compiler, the recording, the queue and the commit options. Between the original Metal 4 segments, shared classic Metal work uses GPU events, and feedback keeps the producer queue's ordering and affinity. When the submission contract is unknown, the original SDK recording stays unchanged. The borrowed classic frame APIs above keep their existing command-buffer types.

Once its replacement is published successfully, a consumer that owns its exact event can omit the redundant original SDK GPU work. Native history, direct window continuation and later producer operations, however, keep the original work when their ownership requires it. After publication, a pending drawable resumes on its existing recording worker and keeps producer order. Resource information neither creates a new presentation timeline nor allows an unprocessed frame between processed deliveries.

A midpoint generated by the SDK is marked as generated, and the depth, motion and material images of its closing real endpoint do not describe it. Compatible image processing stays available for the midpoint, but scene-dependent rows need matching scene data, and another pair operation needs a complete pair and timeline. Exact frame, view and epoch metadata, together with GPU-signaled records of each processed target, also keep the ordinary presenter from applying the same leading effects twice.

### Window continuation

Window continuation lets processing that started on the scene finish on the game's final window image. With `sceneWindowContinuationAPI: 1`, a cooperating producer can register the native destination window for its exact scene tuple. The common presentation path then binds that window, waits on a GPU producer event and runs only the rest of the graph on the final composed color. The binding identifies one final image, and texture dimensions or window titles never establish which window it belongs to. For this reason, subviewports and ambiguous compositions need their own explicit destination contract. Declaring an HDR source does not depend on optional perspective metadata.

### Temporal provider ABI

Temporal upscaling providers implement temporal provider ABI 1, which keeps a separate history owner and a method bitmask. A provider can also export the optional `rsPrepareTemporalResources` symbol, which builds resources without encoding, consuming content IDs or advancing history. Existing providers without that symbol keep the compatible path, which prepares disposable resources.

## Color, alpha and time domains

### Color descriptions

Processing needs to know how each image encodes color, so producers describe it with `RSImageColorDescription`. This structure records the actual RGB primaries (BT.709, Display P3 or BT.2020), the transfer function (sRGB, linear, PQ, HLG or camera BT.709), range, alpha, reference white, luminance limits and whether the image is scene-referred or display-referred. Such explicit color metadata accompanies `rsProcessFrameWithColor`, `rsProcessTemporalFrameColor` and the color-aware presenter and video entry points. In the temporal ABI, the legacy HDR flag means linear BT.709 with 1.0 at 203 nits and a nominal 1000-nit peak, and explicit metadata supplies a more specific contract.

Conversions between these descriptions run in the GPU color encoder, which handles transfer, gamut, range, exposure, alpha and output quantization. A provider that requires bounded sRGB receives a local SDR conversion, while unrelated graph rows keep their source description and precision. Tone mapping into that local conversion changes highlight information, and it does not make an SDR model an HDR model. At the end of the chain, the final output conversion uses the target color description and display headroom.

Several temporal ABI 1 providers work in one fixed color domain. FSR 2, FSR 3, FSR 4, ASR and SGSR2 receive a local linear BT.709, full-range, straight-alpha domain with a 203-nit reference white. Where such a provider consumes a supplied exposure texture, its value is multiplied by `203 / sourceWhite` to compensate for the RGB unit conversion, and the pre-exposure itself stays unchanged. Results then return to the source color domain, including its transparent alpha. For canonical opaque RGBA16F input and output, the redundant color and alpha passes are skipped. These local conversions do not tone map the source or change what the scene guides mean.

### Output tone mapping

The final conversion can compress the image's range for the output. A plan's saved `output.toneMapping` policy selects how: Automatic, Preserve (shown as **None** in the editor), Reinhard or PBR Neutral. Preserve disables final range compression. PBR Neutral requires scene-referred metadata and an image that has not already been mapped for display; otherwise, the final encoder uses Automatic and reports the reason. For a comparison, both sides are mapped with the same selected mapping before they are compared, followed by one final encoding and quantization dither.

### Alpha

Pixel alpha and declared display opacity are separate parts of the frame contract. When display metadata is absent, final game frames are opaque by default, but a producer's explicit transparent value is kept through preparation, processing and presentation. Neural processing, for example, normalizes alpha in its private opaque model input and then restores the source alpha in the result, leaving the source texture unchanged.

### Timing

As stages run, an image keeps its origin, color mode, matching depth, frame ID and available source timing. How much timing there is depends on the interface. The basic `rsProcessFrame` ABI carries the frame ID, color and origin, and when it supplies no timestamp, shader timing uses the local processing clock. The timestamped presenter and offline video interfaces, by contrast, keep their source timing. Captured source timestamps and durations stay attached through asynchronous preparation, publication and same-frame readiness, and a later callback never replaces them with its own arrival time. The processed color, origin and attachment applicability describe the current image, independently of the retained source timing and origin.

Presenter source times use monotonic host seconds compatible with `CACurrentMediaTime`, while offline frame times use the source media timeline in milliseconds, so the two interfaces have separate time origins. The original libplacebo renderer keeps its own clock for hook frames.

A producer of decoded video can also supply each image's media timing, so that frame generation places its images on the video's own timeline. For this, `rsSubmitFramePresenterContent` and `rsSubmitFramePresenterContentAtTime` attach a decoded content stamp to a submission. The stamp holds the content identity, epoch, image revision, PTS and media duration, and it is kept separate from the submission's delivery identity and host time.

Two intervals are derived from these stamps. When PTS is known, the PTS difference between successive decoded images sets the media interval, and the declared duration supplies it when there is no earlier image. The playback interval comes from successive producer deadlines, when they are supplied, and so follows playback-speed changes; without deadlines, it equals the media interval. Each generated phase uses its position within the full media interval for processing and within the playback interval for display. Interpolated playback also keeps one source interval of lookahead, even when that interval is longer than one second. A paused redraw keeps the accepted content identity and media time and adds no interpolation endpoint, whereas a seek or new stream epoch requires a new presenter.

File export follows the same timing as playback: `rsVideoProcessSequence` uses the same generation evaluator and phase timestamp calculation. Export writes the generated in-between images at those media timestamps, followed by the real image that ends the interval. Provider outputs stay provisional until GPU completion validates their receipts. A rejected generated image is left out, and the real image at the end of its interval remains available.

Presenter cadence keeps measured source periods above 240 Hz. An explicit source rate, by contrast, accepts any finite value of at least 1 Hz, with no upper limit, and zero selects observed timestamps. For sources without decoded content timing, interpolation across a long interruption stays within the fixed limits. None of these timing calculations throttle the renderer.

Generation for external window sources, the frame source of [picked windows and displays](INPUTS_AND_ADAPTERS.md#picked-windows-and-displays), also depends on the display. For these sources, the shared generation timeline limits each source interval to the images the display can show. A display refreshing *R* times per second shows about *R* × *T* images from a source interval of *T* seconds, and a quarter refresh of tolerance keeps two images for 24 fps at 60 Hz. This count includes the real image and applies with both Fixed and Adaptive pacing. It also caps every generation stage of the interval together. When the count leaves no refresh for a generated image, as with 2× generation for a 60 fps source at 60 Hz, the interval keeps its real image, no provider work is encoded for it, and the row reports the reason. These real-only intervals use ordinary drawable pipelining and present from the source command buffer, although an active output subframe policy retains its presentation queue. The display limit does not apply to other sources, such as games, or to file export, so they keep every requested generation phase.

The presenter also times the images of external window sources against the display refresh. It displays each image at its due time, and a display refresh shows the image that is current when the refresh latches. The latch point is a refresh time from the display link minus the shortest recently measured delay from submission to display. A batch keeps its schedule when its image changes all fall at least a quarter refresh from the latch points, or as far from them as their spacing allows. Otherwise, the presenter delays the whole batch by less than one refresh, so that the widest gap between the changes' refresh phases is centered on a latch point. As a result, two changes do not share one refresh interval, and timing noise near a latch point does not move an image between refreshes.

A chosen delay carries over to later batches while every change stays at least half that distance from the latch points, so consecutive batches keep their order and spacing. However, the delay never brings a batch's real image closer than half a refresh to the next expected source image. When centering needs more, the batch takes no delay or that limit, whichever keeps its changes farther from the latch points. Batches with application-supplied presentation times keep those times.

### Source frame-rate cap

MacLauncher paces a producer only when the user sets a frame-rate cap. This cap is the plan's `output.frameRateCap`, from 10 to 1000 frames per second, where 0 or an absent value means no cap. Frame adapters that can honor it pace the producer at its frame boundary: the Metal adapter at each drawable request of a game layer, and the OpenGL adapter at the outermost flush of each context. Each producer object has its own schedule, and a producer that falls more than one interval behind starts a new schedule instead of catching up with a burst. The cap applies with or without image processing, and each producer thread reads it from the current plan at most ten times per second. Owned output layers, however, are never paced.

Whether the cap is available depends on the host. A host declares it in `features.graphics.presentation.hosts.<host>.frameRateCap` together with `features.graphics.frameRateCapAPI: 1`. The window and Catalyst hosts declare it, while hosts whose frames arrive through the frame API or a layer surface do not. The master switch removes the cap together with the other output settings.

### Frame generation order

A frame-generation row divides the chain in two. The rows before it, the prefix, process each accepted real source image once, and generation keeps the image dimensions produced by the stage before it. In Advanced, a scaler before frame generation therefore changes its working size, while a scaler after it processes each delivered real or generated image. Final fitting maps the completed chain to the native presentation size, separately from the generation working size.

The interpolation period comes from completed source images, so slower neural processing does not pace generated images from rejected renderer submissions. Each batch keeps that period, its exact chain and the source frame identity. The effects after the generator, the suffix, then run on each delivered real or generated image with a separate output sequence and presentation-phase time. Generated images receive no fabricated game depth or motion. The declared origin stays attached through processing, and the presenter applies its configured final orientation once.

### Background neural processing

In ordinary native presentation, independent neural processing runs beside the game without holding it up. It keeps one source snapshot on the game's command buffer and processes it on an owned queue after the producer completes, without submitting the game's buffer or making the next game submission wait for the worker. While the worker is busy, the previous complete processed output stays visible. Some work still runs in producer order: neural temporal history, scene temporal inputs, frame generation, and explicit presentation targets or observers. When the output is resized, queued work whose dimensions no longer match is discarded, although work already scheduled on the GPU can complete, and its resources stay retained until it does.

### Hidden windows

Processing pauses while its output cannot be seen. For this, native view hosts cache the occlusion state of the output window on the main thread. While that output is hidden, the shared presenter pauses new processing and display phases not yet issued, and it keeps the last complete processed image and the GPU resources it has already accepted. When the window becomes visible, processing resumes through the existing producer and delivery clock, with fresh interpolation history instead of the old queued phases. A window that is inactive but visible keeps processing, and processing also continues normally when visibility is unknown. Virtual-window activation keeps replaying its initial completed image until physical presentation is established.

## Geometry reuse and drawable lifetime

Prepared shader resources are reused as long as their geometry still applies. For native shader reuse, the key that identifies each resource includes the output scale and presentation-relative sizing, and each row also keeps its own input and output image contract. As a result, when the final drawable is resized, stages sized from the source keep their state if their working dimensions do not change, while stages sized from the presentation, and the affected stages after them, prepare separate state. Rejecting a later row leaves the accepted shader and its history intact.

Before it calls the Metal presentation driver, drawable delivery reserves a ticket. The driver call then runs outside the presenter's state mutex, so a presentation callback can read state without waiting on its own caller. The ticket is released only after the driver call has returned and the drawable's presentation or failure callback has completed. Held transitions include these tickets in their drain barrier, and the geometry snapshots that the barrier uses are read before the state mutex is acquired. Presenter layer snapshots, on the other hand, keep their ownership under that mutex. Stopping detaches the layer under the same lock and releases it outside teardown locks. Because layer properties and driver calls stay outside the state lock, callbacks can reenter safely.

Owned presentation also counts the drawables of its output layer that are acquired, queued or displayed. A displayed drawable counts until a later one replaces it, and a dropped or unpresented drawable stops counting when it is released. When the count reaches the layer's maximum, a frame skips presentation without requesting another drawable, because that request would block the submitting thread for up to one second. If these refusals continue for two seconds, the presenter logs it once.

## Game render allocation and processing extent

Processing involves three separate sizes: the game render texture, each effect target and the presentation drawable. The size fields of effect rows control the intermediate processing targets, independently of the game's render-target allocation, and a plan's `renderResolution` field controls source allocation separately. Each row's factor applies to the output of the row before it, and doubling width and height gives four times as many pixels. Drawable dimensions are measured in physical backing pixels, not window points.

### Source requests

A source request in `renderResolution` takes one of these values:

| Value | Source request |
| --- | --- |
| `null` or missing | Keep the game's render size. |
| `{ multiplier: 1 \| 1.5 \| 2 \| 3 \| 4 }` | Divide both presentation dimensions by the multiplier. |
| `{ height: n }` | An integer height from 1 to 16384, preserving the presentation aspect ratio. |
| `{ height: 480, maximum: true }` | A maximum height rather than an exact one, also clamped to the producer's original source size. |

Requested source dimensions stay within the physical presentation dimensions. Existing explicit plans can keep the maximum-height form, whereas manual height selections in Advanced use the exact-height form. The v0.4.0 Simple field `entry.graphics.spatialMultiplier` is upgraded into a `renderResolution` multiplier once, when the record is read, so it keeps its meaning as a source-allocation request.

Either source object can also store `method`, which selects one of the adapter's advertised source filters; omitting it keeps the game's original filter. This selection is independent of spatial effect rows. The Godot adapter, for example, uses it for scene scaling before interface composition. A producer that declares `filterExclusiveWithTemporal` disables source-filter overrides while a temporal node is enabled, although the original filter stays selectable, and other producers keep their own filtering contract. Source preparation passes the selected method to its adapter in `RESHADE_RENDER_SOURCE_METHOD`.

### Source strategies

Source control, which changes the game's own allocation, requires an explicit engine or producer contract. Source requests from both Simple and Advanced prefer a compatible renderer API, then eligible virtual source sizing. When neither is available, compatible ordered chains run a GPU Downsample stage before their other effects instead.

The Godot adapter is a renderer API of this kind. It adjusts Godot's 3D render scale while keeping the original drawable and 2D rendering, which requires the selected engine helper's `sourceResolutionAPI: 1` and an active non-XR root 3D viewport that uses Forward+ or Mobile. The engine scale is limited to `0.1` through `2`, and divisor and maximum-height requests keep a game-selected scale that is already lower. Explicit producers, by contrast, expose their supported divisors through the existing allocation contract. Other frame adapters keep the source their producer supplies, and native video processing keeps the decoded source dimensions.

Accepted requests and native capabilities are separate. A divisor of 4, for example, uses completed-frame Downsample when no source adapter supports that allocation, and this fallback reduces processing work while game rendering keeps its allocation. An allocation request can also include the Downsample reduction as a guard for a renderer that rejects the request after creating its viewport; when the source already meets the target, the reduction skips filtering and allocates no intermediate image. Divisor targets stay relative to the current presentation, while height targets preserve the input aspect ratio and never enlarge the image. Temporal, depth and motion inputs, however, prevent a reduction that would invalidate their geometry.

Launch records and logs keep the requested source, the selected strategy and the reason. If the renderer rejects a live source change in its acknowledgment, the accepted plan and source are restored before one processing fallback attempt. Restoring the original allocation is also an acknowledged source operation, and a failed restoration is reported.

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

These variables alone do not allow resizing arbitrary Metal drawables: generic drawable source control is off unless a producer opts in with `RESHADE_RENDER_SOURCE_CONTROL=drawable`. Engine source adapters instead adjust offscreen rendering through the renderer's own scale settings. The presentation view keeps the native window geometry, backing scale, display selection and fullscreen behavior.

### Resizing and window content

During resizing, a presentation that is already shown keeps its last completed processed image, fitted to the current content bounds, while replacement targets are prepared. Queued output is checked against the current drawable dimensions before encoding and scheduling, so obsolete output never replaces the resized image.

Processing also stays within the game's content. Automatic frame ownership is limited to the window's content-view subtree, so the title bar, toolbar and other window chrome stay outside game processing, and ordinary output presentation stays inside the bounds of the game content.

### Virtual windows

A virtual window provides a requested source reduction when no renderer allocation API is available. A native window host that advertises `virtualWindowAPI: 1` can use it through `RESHADE_RENDER_SOURCE_CONTROL=virtual`. The game is then presented in an ordinary resizable native output window, while the original renderer and responder stay in the source window.

- Resizing the output window adjusts the source content size. The fitted image rectangle also defines absolute pointer mapping, and relative mouse deltas keep their original values. Native title bar controls and resize borders stay outside the mapped game image.
- The source window accompanies the output window into its fullscreen Space. Minimizing suspends both windows, and stopping restores the source window.
- The output window keeps the original content size limits and aspect ratio or resize increments, in window points. The processing scale does not scale those constraints.
- A failed fullscreen transition reconciles the current geometry and releases the transition state. A prepared replacement that has not yet taken ownership leaves fullscreen requests with the original native window.

In this mode, games that size their interface from the window dimensions can change their interface layout, although a scene-renderer adapter can keep interface composition at native resolution. Virtual presentation is created only when the source size changes, and native video and hosts that disable source control keep their original allocation. The mode needs no display mode change or fixed screen resolution. Each completed frame carries its current source and destination sizes, so earlier backing dimensions never define a later frame's allocation.

## Live source commands and virtual windows

### Live source API

A renderer source adapter can also change the source size during play when it advertises `sourceResolution.live`, and the inspector preserves this capability for its source controls. During play, the live source help follows the current launch's source binding, so a capability declared by another process or an earlier session does not apply.

The launcher API has two steps:

- `source-controls.prepare(entry, {userDataDir, support, launchId, source})` creates a separate command and status channel for a launch and returns its environment and binding. Unsupported adapters get no channel, and a null source leaves an unmodified game allocation alone.
- `stage(source, {binding, publication, signal, isCurrent})` prepares an atomic command with a higher epoch, ordered after the effect plan, and returns `wait()` and `rollback()`.

After `publication.commit()`, `wait()` checks for the exact launch, epoch and revision in the renderer's applied result. An unchanged non-null request also requires its current applied result, whereas an unchanged Original request neither waits nor publishes a new command. A valid existing result returns immediately.

On failure, callers first roll back the publication and then await the source transaction's `rollback()`. Because renderers reject older commands, source rollback publishes the previous settings at a higher epoch. A `false` result means the transaction no longer controls the source; a continuing session then reports the failed restoration and keeps the newer command. On malformed or stale input, the engine adapter keeps its last accepted source and restores only the properties it still controls. The Godot adapter provides this live source API with the versioned helper, while other adapters keep their declared allocation contract.

A successful source acknowledgment includes finite applied pixel dimensions, or a finite scale with viewport dimensions. Virtual source acknowledgments also include the observed completed producer size, which matches the applied width and height, because window geometry alone does not acknowledge a rendered source.

### Virtual source channels

Virtual windows use the same command protocol through a channel of their own. A graphics core that declares `virtualSourceControlAPI: 1` extends the protocol to a virtual window requested at launch, and `virtualSourceActivationAPI: 1` also allows a metadata-only null source for launches that start with effects off or at 1×. The existing native window poll reads this channel only while processing, activation or source restoration is needed. An untouched Off state creates no source reader, virtual window, capture, model or GPU work.

A launch can also hold both kinds of channel. A core that declares `virtualSourceChannelAPI: 1` can reserve a second, dormant virtual channel beside a native engine or drawable channel. In the launch record, `sourceControls` maps each control to its binding, while `sourceControl` keeps the primary binding for older consumers. The dedicated virtual binding uses `RESHADE_VIRTUAL_SOURCE_CONTROL_FILE`, `RESHADE_VIRTUAL_SOURCE_STATUS_FILE`, `RESHADE_VIRTUAL_SOURCE_LAUNCH_ID` and `RESHADE_VIRTUAL_SOURCE_ACTIVATION_API`, and its files end in `<launchId>-virtual.json`, with independent epochs and the same launch identity.

With two channels, an update can fall back from one control to another. A native source failure excludes that control for the current update, which then tries virtual allocation and finally completed-frame downsampling. Before it moves the allocation to a different control, the update restores the previous control's original allocation and waits for its exact acknowledgment inside the renderer transaction. If the replacement fails, both the accepted graph and the source are restored. For later edits, an already active compatible control stays preferred. These channels carry prepared control metadata and add no work to frame nodes.

### Virtual window activation

A virtual window can also be activated during play. A live activation prepares output while keeping the original source window's geometry and input. Its first completed image is retained with the same frame identity, so replaying it does not rerun effects or generation. While the windows are visible, activation waits for a positive presentation callback before it changes the source geometry. When both windows stay covered on the active Space, however, a completed opaque image can support background activation without taking focus. That image stays retained for replay once the window is visible, and GPU completion is never reported as physical display. Hidden, minimized or transitioning windows defer activation. A slow first neural image has a limited preparation wait, and cancelling keeps the original.

An applied reduction waits for an acknowledgment that matches the completed source. This acknowledgment includes the source and presentation pixel dimensions, and a later resize invalidates it until another matching frame completes. A producer already at the requested pixel size reports `virtual: false` without creating a proxy output window. An existing proxy, by contrast, accepts live height and divisor changes, including in fullscreen, and keeps its completed image while the source is reallocated. Applied results report the observed producer size.

In windowed mode, a null or full-size source restores the original window once its restored frame completes, and the same launch can enable the virtual source again later. Enabling or removing a virtual window, however, requires leaving fullscreen. Pointer gestures finish before their source coordinate map changes, and invalid or stale commands leave the accepted source in place.

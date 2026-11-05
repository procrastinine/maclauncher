# Graphics pipeline

MacLauncher has one shared graphics layer. Once a runtime hands over a compatible image, the same pipeline runs its image effects, resizing, restoration and frame processing. Native apps, processes translated by Rosetta, browser hosts, Java, Wine, Android and emulator runtimes all connect through frame adapters, so no effect needs a separate integration for each runtime.

Two things do depend on the runtime. Scene temporal algorithms need actual matching inputs from the renderer, and changing the size the game renders at needs a cooperating renderer or the shared virtual window. Processing an image the game has already rendered depends on neither.

The [graphics guide](README.md) covers the editor and everyday use. This page explains how the parts fit together and where each feature plugs into the implementation.

## Reference map

| Topic | Reference |
| --- | --- |
| How specific runtimes supply depth, motion and render-size control | [Renderer integrations](SHARED_PROCESSING.md) |
| Image sources, capture, runtime attachment and scene producers | [Inputs and adapters](INPUTS_AND_ADAPTERS.md) |
| Algorithms, models, input and output contracts and provider requirements | [Providers](PROVIDERS.md) |
| Neural model architectures, packages and imports | [Neural models and packages](NEURAL_RESTORATION.md) |
| Frame APIs, GPU lifetime, color and timing, source sizing and virtual windows | [Frame and presentation APIs](FRAME_API.md) |
| Saved graph, presets, Simple and Advanced, and launcher methods | [Effects plans](EFFECT_PLANS.md) |
| Background preparation, live publication, Off and recovery | [Live updates](LIVE_UPDATES.md) |
| Shader resources, decoder phases, neural import and video export | [Shaders and media](SHADERS_AND_MEDIA.md) |
| Runtime status API, per-launch processor selection and source delivery | [Status and delivery](STATUS_AND_DELIVERY.md) |

## Shared architecture

~~~mermaid
flowchart TB
  subgraph Launcher
    UI["Simple / Advanced / presets"]
    Plan["Shared graph and implementation catalog"]
    Prepare["Cancellable resource preparation"]
    Publish["Atomic revision publication"]
    UI --> Plan --> Prepare --> Publish
  end
  subgraph Runtime
    Producer["Renderer, decoder or software image"]
    Adapter["Frame adapter"]
    Execute["Ordered GPU executor"]
    Present["Presenter and output policy"]
    Producer --> Adapter --> Execute --> Present
  end
  Publish -. "Plan, resources and control metadata" .-> Execute
  Adapter -. "Matching scene guides when supplied" .-> Execute
~~~

In this diagram and on the reference pages, the *producer* is whatever renders the frames: the game's renderer, a video decoder or a software image. *Scene guides* are the renderer data that matches a frame, such as depth, motion, jitter and camera parameters. The launcher handles settings and resource preparation, and *publishes* each prepared plan, which makes it the plan the running game uses. The runtime, in turn, accepts frames, encodes the GPU work and presents the result. Model inference and shader execution work on GPU images, and launcher IPC carries only control metadata.

Frames reach the processor on the GPU wherever the source allows it. Metal images, shared surfaces and decoded textures are handed over on the GPU, OpenGL uses shared texture and surface interop, and libplacebo uses MoltenVK on the same Metal device. A completed software image, such as a Quartz bitmap, needs one initial upload. Intermediate textures and model resources stay retained until their GPU work completes, and unchanged settings reuse compiled resources. When every effect is off, the processor can still be attached in a dormant state, without loading shaders or model weights, so effects can be turned on later during play.

The editor has two views of the same graph: Simple supplies convenient defaults and a default order, while Advanced exposes the graph for explicit ordering. The executor follows that graph and each operation's input and output contract. The diagram, by contrast, shows how data moves between components; the order of effects comes only from the graph.

## Graphics types and feature placement

The editor groups effects into types by how they change their input:

| Editor type | Input → output | Implementations |
| --- | --- | --- |
| Image filter | Image → image | Color, CRT, sharpening, restoration, LUTs and imported effects that preserve image size, and shaders whose size is not determined by their declarations. |
| Downsample | Image → smaller processing image | Area and other kernels, fixed reductions, and shaders that render at a requested smaller or fixed processing size. |
| Upscale | Image → enlarged or fitted image | Spatial filters, fixed-scale neural models and shaders, conditional shader upscalers and shaders that render at a requested larger or window size. |
| Temporal upscaling | Scene frame and history → reconstructed image | MetalFX, FSR, ASR, SGSR2 and scene-capable neural and XeSS providers. |
| Frame generation | Chronological frames → denser image sequence | Image-pair or scene-guided interpolation providers. |

Provider names, shader formats and imported files add implementations inside these types; they never add top-level tabs or a separate execution path. Semantic names such as color, CRT or restoration are also only search tags. How effects compose depends instead on their geometry, color and alpha handling, history and required guides. A neural model, for example, can keep the image size or have an intrinsic scale.

### Shader placement

Which type a shader appears under depends on its geometry, the relation between input and output size that the shader declares. This geometry is read from the shader's declarations before execution and classified once for every editor, menu and library view. Because placement depends only on the declared input-to-output geometry, an imported shader and a collection shader with the same source get the same types, menu entries and default size. Collection names, pack categories, library families and description keywords, on the other hand, affect only labels, search and order within a type.

| Geometry | Output | Type |
| --- | --- | --- |
| Identity | Input size; a chosen output size is a separate fit | Image filter |
| Fixed scale | Input × declared factor | Upscale or Downsample by factor |
| Fixed size | Declared pixels | Downsample, like a fixed-resolution row |
| Conditional | Input or input × declared factor, selected from the window/input ratio | The declared direction |
| Requested size | The row's output size; otherwise the window for display-dependent rules, or the input | The direction of that size, within the declared directions |
| Unknown | Determined while running | Image filter |

A requested-size shader that declares both directions is listed under Image filter, Downsample and Upscale. As an image filter, it runs at its input size; under a resize type, the row's size sets the direction. Resize menus list fixed-direction implementations first and such shaders under Any size.

### Reconstruction, generation and presentation

In this pipeline, scene reconstruction means temporal upscaling guided by the renderer. Image-only restoration and super resolution, by contrast, keep their separate image contracts. Frame generation adds images in time and keeps the size of the images it receives.

Several settings sit outside the effect rows. Motion clarity, final pacing, the performance overlay, display sync and the drawable count belong to presentation. Game resolution, on the other hand, belongs to source allocation, and the frame-rate cap belongs to the frame adapters that pace the game's own rendering. None of these settings changes what an effect row's output size means.

## Frame sources and scene inputs

A frame route is a reusable way of attaching to a runtime:

- Metal and hardware OpenGL adapters receive renderer images directly.
- Layer and completed-bitmap adapters receive their declared full images.
- Dedicated browser hosts can supply a composed window stream.
- For [window graphics](INPUTS_AND_ADAPTERS.md#picked-windows-and-displays), a separate capture service captures a window or display that the user picks, and the processed image is shown in an overlay window over it.
- Runtimes that use the frame API, and the decoded-video host, submit their own textures and timing.

A runtime's name does not say which route is active. Rosetta, for example, changes the process instruction set, and a Direct3D translator changes the renderer's API; both can still feed the ordinary Metal or OpenGL adapters.

Attaching to a window does not mean capturing it. Only two routes use ScreenCaptureKit: the completed browser-window stream and picked windows and displays. Direct Metal and OpenGL handoff and explicit textures use their producer's own synchronization. The [source table](INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs) maps each route to its code and the inputs it supplies.

### Composition boundaries

A few boundaries limit how operations compose. Each one follows from the data involved and the component that owns it:

| Boundary | Effect on the pipeline |
| --- | --- |
| Matching depth, motion, jitter or camera data | Needed only by operations that declare those inputs. A composed RGB image does not supply them. |
| Original decoder planes or metadata | Belong to the native decoder phase. Luma and chroma derived from RGB are a separate GPU computation. |
| Input history and presentation timing | Image-pair generation needs chronological images and a compatible presentation timeline. Generated frames do not gain renderer guides. |
| Known geometry | The shared guide transform carries the guides through supported crops and resizes. An unknown coordinate change cannot supply a correspondence. |
| Game render size | The game's render size changes through a source adapter or an eligible virtual window. A Downsample row changes processing work, independently of the game's rendering cost. |
| Provider resources and device requirements | The selected algorithm keeps its own model, texture, framework, OS and GPU requirements. |

Engine adapters, such as the one for Godot, supply scene resources through the shared scene API. Such an adapter has no separate effects pipeline and no exclusive claim on temporal inputs.

### Runtime and frame adapters

Each module declares how it attaches and which inputs it supplies, through the registry and renderer-specific hooks, and the main process and renderer UI read those declarations. [Module entry points and declarations](INPUTS_AND_ADAPTERS.md#module-launch-entry-points) cover launch orchestration, process architecture and native input metadata. [Renderer integrations](SHARED_PROCESSING.md) describes the integrations of specific runtimes.

## Frame inputs and presentation

A runtime can hand frames to the processor in two ways. The borrowed frame APIs encode processing into the caller's Metal command buffer, and the caller submits that buffer and keeps its resources alive until the GPU completes. When the processor instead presents the output itself, it also handles output scheduling, interpolation and display callbacks. [Frame APIs](FRAME_API.md#borrowed-frames-and-owned-presentation) describe exactly which side owns what.

In both cases, each image carries its color encoding, alpha convention, origin, frame identity and time through the pipeline. Resource preparation, GPU completion and physical display are separate events.

## Saved effects and launcher API

[Effects plans](EFFECT_PLANS.md) document the plan format, the size of each row, preset storage, the upgrade of older settings and the preload methods. A saved plan does not claim that a frame contains scene inputs, and it cannot select arbitrary native code.

A game's saved graphics are its `effects` plan, which is read only through `effects/stored-plan.js`. A record that still holds the v0.4.0 `reshade` and `graphics` fields is upgraded when it loads: one atomic write stores the equivalent plan and removes those fields. The upgrade never prevents a record from loading or a game from starting. Instead, a selection that cannot be converted stays off, with a notice in the editor. A video record's v0.4.0 mpv filter selection stays with mpv's own scaler and adds no row to the graph.

A saved plan is read row by row, so one unreadable part does not stop the rest. A row, source request or output setting that cannot be read is left out of the plan that runs and reported in a skipped notice, while the other rows run at launch, in the editor, in live updates and in video export. The saved value itself is kept until the next edit saves the readable plan. A plan is unreadable as a whole only when it comes from a newer version or its top-level structure cannot be read. In that case, the plan is kept unchanged on save, editing is blocked until **Clear effects**, and launches bypass shared graphics.

## Preparation, ordering and resources

[Live updates](LIVE_UPDATES.md) describe background preparation, cancellation, how a new revision replaces the running one, resource reuse and the recovery of each stage. Because preparation runs in the background, controls never wait for shader compilation or model loading on the render or UI thread. Off cancels preparation that is no longer needed and keeps the saved choices.

While a replacement is temporarily busy, the game keeps showing the last accepted image or keeps running the current chain. After a permanent failure, by contrast, the earlier rendering path stays in place. Independent stages keep running wherever their inputs remain valid.

## Shaders, models and media

[Shader and media integration](SHADERS_AND_MEDIA.md) describes the shared `ShaderNode` interface, prepared resources, imported formats, RGB-derived planes and native decoder prefixes, as well as model import, the reservation of models in use and file-processing entry points. The [provider reference](PROVIDERS.md) maps each format and algorithm to its requirements.

Models are installed separately, and each declares its operation, tensors and scale. For x86_64 processes translated by Rosetta, an ARM64 GPU service runs compatible neural processing. [Neural models and packages](NEURAL_RESTORATION.md) describes the individual model architectures.

## Status and delivery

To show what the running game is doing, the [status API](STATUS_AND_DELIVERY.md#runtime-status-api) exposes the current plan revision, frame source, dimensions and processing events. Its GPU-completion and presentation counters keep their separate meanings. The main process then combines the desired, published and accepted revisions into one [graphics status](STATUS_AND_DELIVERY.md#graphics-status) record per game, which the editor displays.

[Status and delivery](STATUS_AND_DELIVERY.md) also covers how each launch keeps the processor version it started with, the sources the processor is built from, optional provider resources and packaging.

## Code map

| Responsibility | Main locations |
| --- | --- |
| UI and editing | [EffectsControls](../../src/renderer/src/ui/components/EffectsControls.tsx), [editor state](../../src/renderer/src/ui/useEffectsEditor.ts), [edit operations](../../src/modules/shared/effects/edit-operations.mjs), [catalog demand](../../src/renderer/src/ui/useGraphicsCatalog.ts) and its [main-process owner](../../src/main/graphics-catalog.js) |
| Data types and shared catalog | [Contracts](../../src/modules/shared/effects/contracts.mjs), [operation contracts](../../src/modules/shared/effects/operation-contracts.mjs), [plan model](../../src/modules/shared/effects/plan.mjs), [native settings/catalog](../../src/modules/shared/effects/plan.js) |
| Preparation and publication | [Effects runtime](../../src/modules/shared/effects/runtime.js), [ReShade integration](../../src/modules/shared/reshade/index.js), [launch binding](../../src/modules/shared/reshade/launch-binding.js), [saved plan reader](../../src/modules/shared/effects/stored-plan.js), [output options](../../src/modules/shared/effects/output-options.js), [prepared live rows](../../src/modules/shared/effects/prepared-rows.js), [graphics status](../../src/main/graphics-status.js), [per-item results](../../src/modules/shared/item-results.js), [retry schedule](../../src/modules/shared/bounded-retry.js) |
| Native graph and resources | [Plan parser](../../src/modules/shared/reshade/native/effects-plan.mm), [executor](../../src/modules/shared/reshade/native/effects-execution.mm), [scene guides](../../src/modules/shared/reshade/native/scene-guides.mm) |
| Frame ingress | [Metal](../../src/modules/shared/reshade/native/metal.mm), [OpenGL](../../src/modules/shared/reshade/native/opengl.mm), [browser stream](../../src/modules/shared/reshade/native/browser-frame.mm), [picked windows](../../src/modules/shared/reshade/native/window-source.mm), [video host](../../src/modules/video/native/mpv-render.mm) |
| Presentation | [C APIs](../../src/modules/shared/reshade/native/presentation-api.mm), [presenter](../../src/modules/shared/reshade/native/presentation.mm), [window presentation](../../src/modules/shared/reshade/native/view-presentation.mm) |
| Provider integration | [Shader registry](../../src/modules/shared/reshade/shader-providers.js), [temporal registry](../../src/modules/shared/reshade/temporal/providers.js), [neural provider](../../src/modules/shared/reshade/neural/index.js), [frame-generation providers](../../src/modules/shared/reshade/native/generation-provider.mm) |
| Lossless Scaling model storage | [Model store](../../src/modules/shared/reshade/models.js) (`importModel`, `listInstalled`, `resolveModel`, `removeModel`), [model sources](../../src/modules/shared/reshade/model-sources.js), [Steam acquisition](../../src/modules/shared/reshade/steam-models.js) |

Lossless Scaling acquisition goes through the model sources and Steam acquisition modules and then through the same import validation as a local DLL.

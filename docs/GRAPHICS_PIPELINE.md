# Graphics pipeline

MacLauncher has one shared graphics layer. Once a runtime publishes a compatible
image, its image effects, resizing, restoration and frame processing use the same
pipeline. Native apps, translated processes, browser hosts, Java, Wine, Android
and emulator runtimes connect through frame adapters rather than separate
per-effect integrations.

The main exceptions are data requirements and source allocation. Scene temporal
algorithms need actual matching renderer inputs. Changing the game's own render
allocation needs a cooperating producer or the shared virtual-window route.
Processing an already rendered image is independent of that allocation control.

The [graphics guide](GRAPHICS.md) covers the editor and ordinary workflow.
This reference explains where features plug into the implementation.

## Reference map

| Topic | Reference |
| --- | --- |
| Image sources, capture, runtime attachment and scene producers | [Inputs and adapters](graphics/INPUTS_AND_ADAPTERS.md) |
| Algorithms, models, input/output contracts and provider requirements | [Providers](graphics/PROVIDERS.md) |
| Frame APIs, GPU lifetime, color/timing, source sizing and virtual windows | [Frame and presentation APIs](graphics/FRAME_API.md) |
| Saved graph, presets, Simple/Advanced and launcher methods | [Effects plans](graphics/EFFECT_PLANS.md) |
| Background preparation, live publication, Off and recovery | [Live updates](graphics/LIVE_UPDATES.md) |
| Shader resources, decoder phases, neural import and video export | [Shaders and media](graphics/SHADERS_AND_MEDIA.md) |
| Product status API, immutable processor selection and source delivery | [Status and delivery](graphics/STATUS_AND_DELIVERY.md) |

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

The launcher handles settings, resource preparation and publication. The runtime
handles frame admission, GPU encoding and presentation. Model inference and
shader execution consume GPU images; launcher IPC carries control metadata.
A completed software image needs an initial upload. Metal, OpenGL interop,
shared surfaces and decoded textures retain GPU handoffs.

Simple supplies convenient defaults and a default order. Advanced exposes the
same graph for explicit ordering. The executor follows the graph and each
operation's input/output contract; the diagram does not impose a second order.

## Graphics types and feature placement

| Editor type | Input → output | Implementations |
| --- | --- | --- |
| Image filter | Image → image | Color, CRT, sharpening, restoration, LUTs and imported effects that preserve image size, and shaders whose size is not determined by their declarations. |
| Downsample | Image → smaller processing image | Area and other kernels, fixed reductions, and shaders that render at a requested smaller or fixed processing size. |
| Upscale | Image → enlarged or fitted image | Spatial filters, fixed-scale neural models and shaders, conditional shader upscalers and shaders that render at a requested larger or window size. |
| Temporal upscaling | Scene frame and history → reconstructed image | MetalFX, FSR, ASR, SGSR2 and scene-capable neural/XeSS providers. |
| Frame generation | Chronological frames → denser image sequence | Image-pair or scene-guided interpolation providers. |

Provider names, shader formats and imported files add implementations inside
these types. They do not add top-level tabs or a separate execution path.
Semantic names such as color, CRT or restoration are search tags; actual
geometry, color/alpha, history and required guides determine composition.
A neural model can preserve size or have an intrinsic scale.

Shader geometry is read from declarations before execution and classified
once for every editor, menu and library view. Placement depends only on a
shader's declared input-to-output geometry, so an imported shader and a
collection shader with the same source have the same types, menu entries and
default size. Collection names, pack categories, library families and
description keywords affect labels, search and order within a type only.

| Geometry | Output | Type |
| --- | --- | --- |
| Identity | Input size; a chosen output size is a separate fit | Image filter |
| Fixed scale | Input × declared factor | Upscale or Downsample by factor |
| Fixed size | Declared pixels | Downsample, like a fixed-resolution row |
| Conditional | Input or input × declared factor, selected from the window/input ratio | The declared direction |
| Requested size | The row's output size; otherwise the window for display-dependent rules, or the input | The direction of that size, within the declared directions |
| Unknown | Determined while running | Image filter |

A requested-size shader that declares both directions is listed under Image
filter, Downsample and Upscale. As an image filter it runs at its input size;
under a resize type the row's size sets the direction. Resize menus list
fixed-direction implementations first and such shaders under Any size.

Scene reconstruction here is renderer-guided temporal upscaling. Image-only
restoration and super resolution retain their separate image contracts. Frame
generation creates additional time samples rather than a larger image.

Motion clarity and final pacing belong to presentation. Game resolution belongs
to source allocation. Neither changes the meaning of an effect row's output size.

## Frame sources and scene inputs

Frame routes are reusable attachment mechanisms:

- Metal and hardware OpenGL adapters receive renderer images directly.
- Layer and completed-bitmap adapters receive their declared full images.
- Dedicated browser hosts can supply a composed window stream.
- Explicit runtime and decoded-video producers submit textures and timing.

A runtime name does not identify which route is active. Rosetta changes the
process ISA, while a Direct3D translator changes the renderer's API boundary;
both can feed the ordinary Metal or OpenGL adapters.

Window capture is a specific source route, not the meaning of a window
attachment. Only the completed browser-window stream uses ScreenCaptureKit.
Direct Metal/OpenGL handoff and explicit textures use their own producer
synchronization. The [source table](graphics/INPUTS_AND_ADAPTERS.md#frame-sources-and-scene-inputs)
maps these routes to code and available inputs.

### The few composition boundaries

| Boundary | Effect on the pipeline |
| --- | --- |
| Matching depth, motion, jitter or camera data | Needed only by operations that declare those inputs. A composed RGB image does not supply them. |
| Original decoder planes or metadata | Belong to the native decoder phase. RGB-derived luma/chroma are a separate GPU computation. |
| Input history and presentation timing | Image-pair generation needs chronological images and a compatible presentation timeline. Generated frames do not gain renderer guides. |
| Known geometry | The shared guide transform carries actual guides through supported crops/resizes. Unknown coordinate changes cannot invent a correspondence. |
| Producer allocation | Game render size uses a source adapter or eligible virtual window. A Downsample row changes processing work, independently of game rendering cost. |
| Provider resources and device contract | The selected algorithm retains its actual model, texture, framework, OS and GPU requirements. |

These boundaries follow the data and owning component. An engine adapter such as
Godot supplies scene resources to the common boundary; it has no separate effects
pipeline or exclusive claim on temporal inputs.

## Runtime and frame adapters

Modules declare attachment and input contracts through the registry and
renderer-specific hooks. Main and renderer UI consume those contracts.
[Module entry points and declarations](graphics/INPUTS_AND_ADAPTERS.md#module-launch-entry-points)
cover launch orchestration, process architecture and native input metadata.

## Frame inputs and presentation

Borrowed frame APIs encode into the caller's Metal command buffer. The caller
owns submission and retains its resources through completion. Owned presentation
adds output scheduling, interpolation and display callbacks.
[Frame APIs](graphics/FRAME_API.md#borrowed-frames-and-owned-presentation) describe
the exact division of ownership.

Color encoding, alpha convention, origin, frame identity and time remain attached
to each image. Resource preparation, GPU completion and physical display are
separate events.

## Saved effects and launcher API

[Effects plans](graphics/EFFECT_PLANS.md) document the canonical schema, per-row
extent, preset storage, legacy migration and preload methods. Saved requests do
not assert that a frame contains scene inputs or select arbitrary native code.

A game's saved graphics are its `effects` plan, read only through
`effects/stored-plan.js`. A record that still holds v0.4.0 `reshade` and
`graphics` fields is upgraded when it is loaded: one atomic write stores the
equivalent plan and removes those fields. The upgrade never prevents a record
from loading or a game from starting; a selection that cannot be converted
stays off with a notice in the editor. A video record's v0.4.0 mpv filter
selection remains with mpv's own scaler and adds no graph row.

A saved plan is read row by row. A row, source request or output setting that
cannot be read is left out of the plan that runs and is reported as a skipped
notice; the other rows run at launch, in the editor, in live updates and in
video export. The saved value is kept until the next edit saves the readable
plan. Only a plan from a newer version or one whose top-level structure cannot
be read is unreadable as a whole: it is kept unchanged on save, editing is
blocked until Clear effects and launches bypass shared graphics.

## Preparation, ordering and resources

[Live updates](graphics/LIVE_UPDATES.md) describe background preparation,
cancellation, revision adoption, resource reuse and per-stage recovery.
Controls do not wait for shader compilation or model loading on the render/UI
thread. Off cancels obsolete preparation and retains saved choices.

A temporarily busy replacement retains a coherent accepted image or compatible
execution. A terminal failure retains the stable rendering path for that
contract. Independent stages continue where their input contracts remain valid.

## Shader selection and native video filters

[Shader and media integration](graphics/SHADERS_AND_MEDIA.md) describes the shared
ShaderNode boundary, immutable resources, imported formats, RGB-derived planes
and native decoder prefixes. The [provider reference](graphics/PROVIDERS.md)
maps each format and algorithm to its requirements.

## Local neural models and offline processing

Models are separate managed inputs with operation, tensor and scale contracts.
The ARM64 GPU service supplies compatible neural processing to translated
clients. [Neural restoration](NEURAL_RESTORATION.md) describes individual model
architectures; [model and media APIs](graphics/SHADERS_AND_MEDIA.md) describe
import, leases and file-processing entry points.

## Sources and distribution

[Status and delivery](graphics/STATUS_AND_DELIVERY.md) covers immutable per-launch
processor binding, exact source inputs, optional provider resources and packaging.

## Runtime processing status

The [status API](graphics/STATUS_AND_DELIVERY.md#runtime-status-api) exposes the
current plan revision, frame source, dimensions and processing events. Its GPU
completion and presentation counters retain their distinct meanings.
The main process combines desired, published and accepted revisions into one
[graphics status](graphics/STATUS_AND_DELIVERY.md#graphics-status) record per
game, which the editor displays.

## Code map

| Responsibility | Main locations |
| --- | --- |
| UI and editing | [EffectsControls](../src/renderer/src/ui/components/EffectsControls.tsx), [editor state](../src/renderer/src/ui/useEffectsEditor.ts), [edit operations](../src/modules/shared/effects/edit-operations.mjs), [catalog demand](../src/renderer/src/ui/useGraphicsCatalog.ts) and its [main-process owner](../src/main/graphics-catalog.js) |
| Data types and shared catalog | [Contracts](../src/modules/shared/effects/contracts.mjs), [operation contracts](../src/modules/shared/effects/operation-contracts.mjs), [plan model](../src/modules/shared/effects/plan.mjs), [native settings/catalog](../src/modules/shared/effects/plan.js) |
| Preparation and publication | [Effects runtime](../src/modules/shared/effects/runtime.js), [ReShade integration](../src/modules/shared/reshade/index.js), [launch binding](../src/modules/shared/reshade/launch-binding.js), [saved plan reader](../src/modules/shared/effects/stored-plan.js), [prepared live rows](../src/modules/shared/effects/prepared-rows.js), [graphics status](../src/main/graphics-status.js), [per-item results](../src/modules/shared/item-results.js), [bounded re-reads](../src/modules/shared/bounded-retry.js) |
| Native graph and resources | [Plan parser](../src/modules/shared/reshade/native/effects-plan.mm), [executor](../src/modules/shared/reshade/native/effects-execution.mm), [scene guides](../src/modules/shared/reshade/native/scene-guides.mm) |
| Frame ingress | [Metal](../src/modules/shared/reshade/native/metal.mm), [OpenGL](../src/modules/shared/reshade/native/opengl.mm), [browser stream](../src/modules/shared/reshade/native/browser-frame.mm), [video host](../src/modules/video/native/mpv-render.mm) |
| Presentation | [C APIs](../src/modules/shared/reshade/native/presentation-api.mm), [presenter](../src/modules/shared/reshade/native/presentation.mm), [window presentation](../src/modules/shared/reshade/native/view-presentation.mm) |
| Provider integration | [Shader registry](../src/modules/shared/reshade/shader-providers.js), [temporal registry](../src/modules/shared/reshade/temporal/providers.js), [neural provider](../src/modules/shared/reshade/neural/index.js) |

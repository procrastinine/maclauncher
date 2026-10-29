# Effects plans and launcher APIs

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

Simple and Advanced use one canonical graph and implementation catalog. The editor presents input/output types; providers and imported shaders implement those types.

[Shared types and implementation selection](#shared-types-and-implementation-selection) · [Saved graph and resize schema](#saved-graph-and-resize-schema) · [Preset storage](#preset-storage) · [Launcher API and Simple migration](#launcher-api-and-simple-migration) · [Ordering and scene boundaries](#ordering-and-scene-boundaries)

## Shared types and implementation selection

Graphics types describe **input → output**. Image filters, downsampling,
resize shaders, upscaling, temporal upscaling and frame generation select implementations within
the same type system. Simple controls and Advanced rows use one catalog, saved
graph and execution path. An imported shader adds an implementation to the
library rather than another top-level type or tab.

`effects/contracts.mjs` supplies the shared type classifier and implementation
matching. Catalog `inputContract` and `outputContract` describe data domains,
required guides, output extent/rate and history; provider adapters supply the
algorithm. Color, CRT and restoration tags support search independently of these
contracts. Same-size neural filters and fixed-scale CNN upscalers therefore
retain their actual output geometry. The common executor owns frame handoff,
failure isolation and GPU resource lifetime; generators share the presenter and
its display timeline.

Large implementation menus include local search by name and descriptive tags.
Arrow keys move through matches, Enter selects, and Escape closes the menu.
Off and Manage filters remain accessible alongside the search results. Search
does not change the saved graph or contact a server.
The same prepared catalog orders Simple, Advanced and the Add chooser. Each
row's `recommendationRank` sets its menu tier: 0 for the suggested default
(MetalFX where the GPU supports the operation), 1 for common choices such as
FSR 1, bilinear, bicubic, nearest neighbor, area, FSR 3, Lossless Scaling Frame
Generation, CAS, Sharpen, CRT and Colour, 2 for ordinary rows and 3 for
specialised variants: libplacebo kernels other than Lanczos, EWA Lanczos,
Spline (3 taps), Mitchell-Netravali and Catmull-Rom, and installed collection
files that their collection does not name. Ranks 0 and 1 appear first under
**Recommended**; rank 3 appears after **More**, or in search results, under its
group's heading after that group's other rows. A selected row is always listed.
When a game's frame source declares its inputs, a row that
needs an input the source omits carries `inputsAbsent`, a reason naming the
missing inputs, and is listed under **Needs scene inputs** after the ordinary
groups; it remains selectable. Methods that the engine runs itself are exempt.
Shader packs and built-in presets declare a `purpose` for ordinary shaders:
Sharpen, Colour and tone, CRT and retro, Anti-aliasing and blur, Lighting and
lens, Restoration, Depth, Accessibility or Artistic. Effects that read renderer
depth take Depth. Menus head ordinary shaders by purpose in that order. A pack
effect whose label begins with the pack name carries that name as `family`;
menus omit it from the displayed name when the effect type or menu heading
already names it, and search still matches it. Stored identifiers, library names
and preset references keep the full label. Availability reasons appear as a
secondary note beside the name.
Confirmed MetalFX spatial support favors the native upscaler for automatic
fitting. Manual and imported selections retain their settings and eligibility.
The graphics library's Type filter uses the same classifier. One geometry
classifier reads each shader's declared output before execution: identity,
fixed scale, fixed size, conditional (a declared condition selects between
sizes), requested size (the row's output size; otherwise the window for
display-dependent rules, or the input) and unknown. Identity and unknown
shaders are Image filters. A fixed pixel size is Downsample, like a
fixed-resolution row. Fixed and conditional scales are Upscale or Downsample by
their declared direction. A requested-size shader takes the
direction of its row's size: input-relative factors below 1, window fractions
below 1 and fixed pixel sizes are Downsample; larger factors and window fits are
Upscale; no size keeps its default. Ordinary menus list it under that default
type and, when it declares resize directions, under each of them. One declaring
both directions is also an Image filter, placed at its input size. Output
contracts retain actual scales, scale ranges and geometry rules. Accepting a
target allocation alone does not make a color filter a resampler. Purpose tags,
collection membership and filenames never assign output geometry, menu
membership or default size; an imported copy of a collection shader is placed
identically. Explicit
custom placement can use a requested-size or unknown shader when its provider
accepts that extent and the slot's default size yields that type; placement then
saves that size, so the row is displayed where it was placed.
A same-size filter keeps its Image filter type when an output size is chosen;
the size is a separate fit after the shader.

## Saved graph and resize schema

Legacy Simple settings remain readable from `entry.reshade` and `entry.graphics`.
Both editor views can edit the same canonical graph in `entry.effects`:

```js
entry.effects = {
  schema: 2,
  mode: "advanced",
  enabled: true,
  renderResolution: { height: 480 },
  video: [
    { id: "colour", kind: "shader", enabled: true,
      shader: { enabled: true, preset: "grayscale", parameters: { V__Strength: [1] } } },
    { id: "scale", kind: "upscale", enabled: true,
      method: "fsr1", extent: { relativeTo: "presentation", factor: 1 },
      settings: { spatialSharpness: 0.5 } }
  ]
};
```

The plan model validates unique stable row IDs, supported settings and finite
numeric values. Limits are 32 rows, 4096 parameter names per advanced shader,
one to four numeric components per value and a 4 MiB serialized plan. Graphics
rows use `downsample`, `upscale`, `temporal` or `frame-generation` kinds and
normalized graphics settings. A `neural` row uses its provider's separate
settings contract. Image filters and shader CNNs retain the `shader` kind;
their declared geometry determines the editor category. Compatible generators
can compose when the later provider accepts synthetic inputs. Scene generators
that require original scene frames retain that input requirement.
LSFG, MLX interpolation and RIFE use shared GPU image-pair analysis to suppress
synthetic descendants across exact repeated images, estimated image cuts and
invalid pairs. Decisions belong to the exact pair, source epoch and upstream
image revision and become usable after their GPU completion. Real endpoint
frames remain valid. An image-cut estimate does not supply renderer scene
information; scene-based generators retain their provider's reset contract.
Image filters can also declare a typed model input. Their optional
`settings.modelPath` is `null` for Automatic or an explicit compatible package.
The validated filter descriptor supplies `modelOperation`; it is not an editable
graph type. `MODEL_OPERATIONS` includes scalar attachment models, while `NEURAL`
contains only image/timeline operations. Model selection, acquisition, leases,
live authorization and cancellation use the same path for both consumers.
Prepared attachment rows carry the resolved model path and operation in their
resource identity. Changing the model or an input parameter invalidates obsolete
preparation; Off retains the saved selection without requesting inference.
Derived data follows the enabled consumers' input requirements. Unused guide
normalization, estimators, plane conversion and model preparation remain idle.
Existing matching inputs and same-generation intermediates are reused; a
relevant image or geometry change invalidates the derived result.
Saved plans contain settings and source selections; they do
not assert renderer capabilities or provide native resource paths.

`output.toneMapping` accepts `auto`, `preserve`, `reinhard` or `pbr-neutral`.
Absence selects Automatic. An explicit policy works without an effect row;
the whole-graph switch still bypasses it. Preparation retains unsupported
requests as pending output metadata while independent rows continue on an older
processor. Scene-referred eligibility is resolved from the actual image at the
final color boundary.

Schema 2 resize rows select their algorithm independently from `extent`:

```js
{ id: "reduce", kind: "downsample", enabled: true, method: "area",
  extent: { relativeTo: "input", factor: 0.5 }, settings: {} }
```

An input-relative factor acts on that row's actual input. A presentation-relative
factor follows physical window dimensions and Retina changes, preserving the
input aspect ratio. Explicit `{width, height}`, `{width}` or `{height}` extents
use whole pixels from 1 to 16384; a single axis preserves aspect ratio.
Downsample clamps its target to the input extent. Upscale retains the selected
provider's intrinsic or negotiated output contract. Area, conventional kernels,
libplacebo kernels and imported reduction shaders remain separate algorithms.
A learned shader with intrinsic 2× output is an Upscale and retains its declared
2× scale. In Simple it receives the same input request and window fit as an
intrinsic-scale model; the fit row's size is edited from the shader's options and
remains owned by the shader.

Schema 1 `spatial` rows remain readable. Their `settings.spatialMultiplier`
describes an output/input factor; missing or null selects presentation fit.
Legacy `outputSize` and `presentationScale` remain accepted. A real edit migrates
known reduction/enlargement rows to schema 2 without reordering them; ambiguous
legacy fit rows retain their fit semantics. The old `method: "downsample"`
migrates to an explicit Downsample row using Bilinear. LSFG's `frameMultiplier`
changes temporal rate independently of image dimensions.

### Sizing helpers

A schema 2 resize row can size the image for another row:

```js
{ id: "reduce", kind: "downsample", enabled: true, method: "bilinear",
  extent: { relativeTo: "presentation", factor: 0.5 }, settings: {},
  ownedBy: { id: "scale", role: "input" } }
```

`ownedBy` holds exactly the owner's row ID and a role: `input` reduces the image
before the owner, and `fit` fits its output after it. Only `spatial`,
`downsample` and `upscale` rows can be helpers. The owner is an unowned
`shader`, `spatial`, `upscale` or `neural` row of the same plan, and it has at
most one helper per role. Validation reports a helper whose owner is missing,
is itself a helper or cannot own helpers; it does not repair the plan. A source
request made for an owner's input helper names that owner in
`renderResolution.managedBy`. Outside the ownership migration below, row IDs
never imply ownership.

`effects/edit-operations.mjs` applies every plan edit as a pure operation that
keeps these rules. Helpers and the owned source request follow their owner's
enabled state, removal, position and implementation, including while the owner
is off. An input helper owns the source request made for it, so removing the
helper also removes that request; `clear` removes every row and owned request
and keeps a source request made on its own. Editing a helper directly, other
than through its owner's fit size, makes it an ordinary row. Helper derivation uses the shared geometry classifier
only. An Upscale owner receives an input reduction and, at a fixed scale, a fit
after it, unless another source request, an explicit owner size or another
reduction makes sizing manual. A neural image row receives the 540-pixel
processing input, except for decoded video, and a fit when the chain has no
other reduction or upscaler. A fixed pixel size is Downsample and derives no
helpers. A shader replacing a row keeps the row's explicit factor or pixel
size, even when that size gives the shader another resize type; a presentation
fit or automatic size takes the new slot's default. A fixed-scale model's fit uses a filter available in both
directions, so it follows the window whether the model output is larger or
smaller. Imported shaders with the same declared geometry as included ones
produce the same rows, types, helpers and source requests.

`migrateOwnership` gives conventionally named helpers (`auto-scale-input-…`,
`auto-scale-fit-…`, `auto-nr-input-…`, `auto-nr-fit-…`) of a schema 2 plan
explicit ownership. It removes helpers whose owner is missing or cannot own
them, keeps one helper per role, disables helpers of a disabled owner, restores
each helper to its side of the owner and removes a managed source request whose
owner is missing or disabled. Migration is idempotent.

### Reading saved plans

A saved plan that fails validation is reported, never replaced by another plan
or by the legacy Simple fields. `inspect(value)` returns `{plan: null}` for an
absent value, `{plan}` for a valid one, and otherwise
`{error: {code, message}}` with `GRAPHICS_PLAN_NEWER` for a later schema or
`GRAPHICS_PLAN_INVALID`. `normalize(value)` returns the plan or `null` and
throws the same error, with its `code`, for an invalid plan. The Node module
applies its settings and provider checks through the same result. Launch
preparation bypasses shared graphics for an invalid saved plan and leaves its
legacy fields unused.

### Output comparison

`output.comparison` selects `off`, `before`, `wipe` or `difference` with a
normalized `position` and a difference `gain` from 1 to 16. It is an output
policy shared by both editor views, rather than another effect type. The GPU
comparison aligns the admitted source image with the processed result and
uses the same color domain and alpha contract. A source can already contain
the renderer's own processing or a native decoder prefix.

`comparisonAPI: 1` supplies this policy for ordinary presentation and file
processing. Export retains the saved comparison choice through the same GPU
helper. Comparison alone requires the shared processor, without loading neural
models or a frame generator. Turning it off hides its options and retains the
saved position and gain.

### Depth input

`depthInput` holds the game's ReShade depth-input definitions for `.fx` rows
whose compiled program reads depth. `reversed` and `logarithmic` select
`RESHADE_DEPTH_INPUT_IS_REVERSED` and `RESHADE_DEPTH_INPUT_IS_LOGARITHMIC`;
`farPlane` (1 to 1000000) selects `RESHADE_DEPTH_LINEARIZATION_FAR_PLANE`, and
`multiplier` (0.001 to 1000) selects `RESHADE_DEPTH_MULTIPLIER`. Without a
saved value, depth is not reversed and the other definitions keep each shader's
own defaults (ReShade's are linear depth, a far plane of 1000 and a multiplier
of 1). A saved plan keeps only the values that differ from these defaults, and
an invalid saved value is skipped on its own. Both editor views show these
settings as Depth input on each qualifying row when the graphics runtime reports
`depthInputAPI: 1`; a change applies to every such row of the game. Applying a
preset and Clear effects keep the game's depth input. Other shader formats and
filters that unproject depth with a renderer-supplied projection do not use
these definitions.

### Adaptive processing size

`output.adaptiveQuality` contains `enabled`, `nodeId`, `budgetMs`, `minScale` and
`maxScale`. Budgets range from 0.25 to 1000 milliseconds; scale bounds range
from 1/16 to 1, with the minimum no larger than the maximum. It targets a
Downsample row through that row's existing Output size options. Bounds multiply the canonical row extent; transient working sizes do
not rewrite its saved dimensions, the output dimensions or frame timestamps.
Off restores the canonical extent. A removed or disabled target leaves the
policy pending while other rows retain their normal execution.

The shared `EffectQualitySession` receives completed GPU-job durations and uses
the ordinary asynchronous graph replacement path. It retains accepted output
during replacement and rejects stale decisions after a changed plan, seek or
Off. Provider `gpuWorkScope` metadata identifies work encoded in the caller's
command buffer and work using external queues. The policy needs a timing scope
covering its affected work; an unmeasured external operation leaves it pending.
Libplacebo supplies optional versioned GPU-timing functions without changing
the shader-node ABI. Its render-queue timestamps cover the affected operation;
all affected external intervals must match before the session observes one
real-input sample. Unrelated rows, stale intervals and caller waits are excluded.
The same policy and status contract apply to window processing and file export.

## Preset storage

Advanced preset metadata lives in `graphics/effects-presets.json` under the
application data directory. The preset store uses the shared effects-plan
validator, atomic writes and revision checks for edits from multiple windows.
It stores up to 128 named snapshots within a 16 MiB metadata limit. An
unreadable library file blocks preset edits and is not replaced. Within a
readable file, each preset is read on its own: a preset with unreadable rows
is listed with its readable rows and a notice for each skipped row, and a
preset that cannot be read at all is not listed and is reported through
`getEffectsPresetNotices()`. Saving or removing another
preset keeps the stored bytes of both. Preset
storage does not prepare or publish a running plan. Applying a snapshot uses
the ordinary per-game preparation path, including resource, ordering and
renderer validation. Game records contain the copied plan, with no link that
allows later preset edits to modify the game.

## Launcher API and Simple migration

The launcher preload exposes these operations:

| Method | Behavior |
| --- | --- |
| `getGameEffects(gamePath)` | Returns the readable saved plan, the current per-game catalog, source-resolution capabilities, native-binding timing, `notices` and the [graphics status](STATUS_AND_DELIVERY.md#graphics-status). An unreadable saved plan is returned as `graphicsPlanError` with an empty editor plan. |
| `getGameEffectTemplates(gamePath)` | Returns the contextual templates for the graphics menu, read when the menu opens. |
| `requestGraphicsCatalog({open, revision})`, `onGraphicsCatalog(callback)` | Declare and release a view's demand for the launcher's graphics catalog and receive each new catalog revision while demand is held; see [Preparation, live switching and resource ownership](LIVE_UPDATES.md#demand-analysis-and-prepared-resources). |
| `getGameEffectParameters(gamePath, nodeId, draftPlan?)` | Describes a shader's parameters without saving or activating the draft. |
| `pickGameEffectFile(gamePath, kind?, operation?)` | Selects a local shader or, for `kind: "neural-model"`, a compatible managed model or original model source. Import returns its managed path; an expected operation validates the package before attaching it to a row. Cancellation changes no settings. |
| `setGameEffects(gamePath, plan, request?)` | Applies the edit to the saved plan, rebasing it when `request.basePlan` names the plan it was made from, validates the result once and saves it. A row that cannot be read is left out and listed in `notices`; the readable rows are saved and published. A running game with live graphics editing receives the prepared plan; other games use it at the next launch. Returns the saved plan and its revision. A plan whose top-level structure cannot be read is rejected, and an unreadable saved plan rejects edits until it is cleared. |
| `resetGameEffects(gamePath)` | Explicitly clears the chain and its upgrade notices. Changing editor view does not call it. |
| `getGraphicsStatus(gamePath)`, `onGraphicsStatus(callback)` | Read and observe the game's [graphics status](STATUS_AND_DELIVERY.md#graphics-status). |
| `listEffectsPresets()` | Lists independent Advanced plan snapshots from the local library. |
| `getEffectsPresetNotices()` | Lists a notice for each saved preset that could not be read; such presets are kept in the library file. |
| `saveEffectsPreset({ id?, name, plan, updatedAt? })` | Creates a snapshot or updates the matching revision without changing games. |
| `deleteEffectsPreset(id, updatedAt)` | Removes the matching revision while preserving applied game copies. |
| `getEffectsPresetEditor(plan?)` | Provides the shared catalog and an inactive plan for the Settings editor. |
| `getEffectsPresetParameters(nodeId, plan)` | Describes parameters in a preset draft without activating it. |
| `pickEffectsPresetFile(kind?)` | Uses the same local shader/model chooser without requiring a game record. |

Each notice is `{message, rowId?, dropped?}`. `rowId` names a row that an
upgrade kept off in the plan; `dropped: true` marks a saved row, source request
or output setting that is not in the plan because it could not be read. Library
records carry the same notices as `effectsNotices`, with the readable plan as
`effects`.

Changing between Simple and Advanced preserves the canonical plan, row order
and saved choices. Saved v0.4.0 Simple fields are upgraded to that plan once,
when the game record is loaded. Reset
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

### Legacy Simple migration

Entries without a canonical plan retain Simple neural settings in
`entry.graphics`: `neuralMethod` is `off` or `mlx-dlss`, and
`neuralModelPath` is a local model package or `null`. An explicit
`neuralInputHeight` or `neuralInputScale` retains its pixel or window-relative
meaning. With neither selected, games start at a fixed 540-pixel height; native
decoded video retains its input dimensions. `neuralIntensity` defaults to 1 and
`neuralTemporal` to false. Neural processing is off by default.

The synthesized plan contains explicit reduction, neural and final-fit rows.
Historical automatic Downsample extents normalize to `{height: 540}`, and size
fields saved beside one are superseded by that height; no window-dependent size
is inferred. `ReShade.automaticResolutionOptions` marks
Simple composition only, without generating `resolutionAuto` fields. The
capability-aware editor and executor share this canonical plan. Existing
canonical manual factors, pixel sizes and row order remain intact.

Live edits can change installed models, compatible order, sizes, intensity,
history and frame generation. The renderer retains its accepted output while a
replacement prepares. Source allocation follows the native → virtual →
completed-frame fallback contract. Engine-composited neural processing keeps
its original complete frame rather than scaling the 3D scene and then reducing
the composite again. Processing reduction alone does not reduce game rendering
cost. On hosts with a compatible full-frame source adapter, the same fixed-height
request can reduce allocation before effects.

When neural processing or final fitting is unavailable, preparation removes
only its dependent convenience reduction and source request. Independent rows
remain usable. Manual Advanced rows retain their requested sizes. A runtime
inference failure retains the current stage input and the complete-image
presentation path.

The catalog combines the selected processor's capabilities with actual input
metadata from the frame source. Both views consume that catalog. Native builds
advertise ordered execution through `features.graphics.effectPlanAPI: 1`;
`effectPlanKinds` describes the node contracts parsed by that payload. A compiled
FX technique's texture semantics and a compiled filter's typed declaration
determine its required scene inputs. Missing depth, motion, camera or matrices
leave the affected row pending while compatible image rows continue.

## Ordering and scene boundaries

Each enabled row receives the previous row's output. A coordinate-preserving
effect retains matching guides. With `sceneGuideTransformAPI: 1`, known crop and
resize transforms normalize real depth, motion, jitter, masks, exposure and
available camera metadata for the next scene provider. Output-resolution motion
and texture subregions retain their declared conventions. Reconstructed depth
is retained through its actual GPU use, including a later presentation command
buffer. Older processors retain their original-extent scene requirement.

Generated images do not acquire renderer guides. A shader with an unknown
coordinate transform cannot establish guide correspondence. The planner and
per-frame checks enforce the actual required inputs without moving saved rows
or fabricating data. Order is checked row by row against the rows before it
that run: a row that breaks it, including through requirements found only by
the compiler, is bypassed with its reason and the other rows keep their places.
Spatial output-size controls apply to every supported frame adapter. A final
fit to the presentation target handles a chain whose last output has different
dimensions; it does not change the game renderer's allocation. Processing extents
are sampling grids and retain the producer's logical window/output mapping.
Different width and height sampling densities still fill that mapped target.
These size controls do not declare a crop or a change in display aspect.

Ordered temporal scope is declared in `features.graphics.effectPlanTemporal`.
The original MetalFX adapter requires a full output covering the exact acquired
drawable and a classic command buffer. Its producer input metadata identifies
`temporalSource: "original-metalfx"`, `temporalOutput: "acquired-drawable"` and
`commandBuffer: "classic"`, in addition to the method's scene inputs. These
facts must come from the renderer integration. Depth and motion alone do not
establish output ownership. A one-use binding identifies the original scene frame,
command buffer and output texture; only the remaining effect rows run at
presentation. Offscreen, subrectangle and ambiguous output paths retain the
original scaler. Both editor views select the same provider input contract.

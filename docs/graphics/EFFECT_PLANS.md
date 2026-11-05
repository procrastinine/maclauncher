# Effects plans and launcher API

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

A game's graphics settings are saved as one effects plan in the `effects` field of its library record. The plan is an ordered list of effect rows, together with the game's source-size request, output settings and depth input. Both editor views, Simple and Advanced, edit the same plan, read the same catalog and use the same execution path. Providers and imported shaders add implementations to the plan's row types, but they never add another type.

This page describes the plan format, how saved plans are read and upgraded, the catalog the editor builds plans from, preset storage and the launcher methods that read and change plans. [Shader placement](PIPELINE.md#shader-placement) describes how a shader's declared geometry selects its row type.

[Plan format](#plan-format) · [Plan settings](#plan-settings) · [Reading saved plans](#reading-saved-plans) · [Graphics catalog](#graphics-catalog) · [Preset storage](#preset-storage) · [Launcher API](#launcher-api) · [Ordering and scene boundaries](#ordering-and-scene-boundaries)

## Plan format

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

Two modules implement this format: `effects/plan.mjs` is the browser-safe plan model, and `effects/plan.js` adds native settings validation and catalog construction. A valid plan needs unique, stable row IDs, supported settings and finite numbers. Its size is also limited to at most 32 rows and at most 4 MiB when serialized. An advanced shader row can have at most 4096 parameter names, and each parameter value has one to four numeric components.

Each row's `kind` selects its settings contract:

| Kind | Rows |
| --- | --- |
| `shader` | Image filters and shader CNNs. The shader's declared geometry decides its editor type. |
| `downsample`, `upscale` | Schema 2 resize rows, sized by `extent`. |
| `spatial` | Resize rows from schema 1 and fit rows that follow the presentation size. |
| `temporal` | Temporal upscaling. |
| `frame-generation` | Frame generation. `frameMultiplier` changes the frame rate and leaves image dimensions alone, as [frame-generation rows](#frame-generation-rows) describe. |
| `neural` | Neural rows. They use their provider's own settings contract. |

Rows store normalized graphics settings. A saved plan holds only these settings and source selections, so it makes no claim about renderer capabilities and provides no native resource paths. [Combining generation stages](PROVIDERS.md#combining-generation-stages) describes which frame generators can follow one another.

### Resize rows

A schema 2 resize row chooses its algorithm (`method`) separately from its size (`extent`):

```js
{ id: "reduce", kind: "downsample", enabled: true, method: "area",
  extent: { relativeTo: "input", factor: 0.5 }, settings: {} }
```

| `extent` | Size |
| --- | --- |
| `{relativeTo: "input", factor}` | A factor of the row's actual input. |
| `{relativeTo: "presentation", factor}` | A factor of the physical window dimensions, following Retina changes and keeping the input aspect ratio. |
| `{width, height}`, `{width}` or `{height}` | Whole pixels from 1 to 16384. A single axis keeps the aspect ratio. |

Downsample clamps its target to the input size, while Upscale keeps the output size that the selected provider has by design or negotiates. Area, conventional kernels, libplacebo kernels and imported reduction shaders are separate algorithms, each selected through `method`.

A learned shader with an intrinsic 2× output counts as an Upscale and keeps its declared 2× scale. In Simple, it receives the same input request and window fit as a model with an intrinsic scale. The size of that fit row is edited from the shader's options, and the row stays owned by the shader.

A `spatial` row, which holds a schema 1 resize or a fit, stores its size differently: `settings.spatialMultiplier` is an output/input factor, and a missing or null value means a fit to the presentation size. Its older `outputSize` and `presentationScale` fields are still accepted. [Upgrading v0.4.0 settings](#upgrading-v040-settings) describes how schema 1 rows become schema 2 rows.

### Neural rows

```js
{ id: "reconstruct", kind: "neural", method: "mlx-dlss", enabled: true,
  settings: { modelPath: "/models/reconstruction.dlssmodel", temporal: false, intensity: 1 } }
```

A neural row runs a local model through the neural provider. Its `modelPath` selects the model package, and `intensity`, a finite value from 0 to 1, sets how much of the model output is used: 1 uses the full output, and lower values blend the reconstruction with the input. With the default `temporal: false`, each frame is processed on its own. With `temporal: true`, the provider instead estimates bidirectional optical flow from captured color frames and keeps its own history. That history is reset by a new stream, by a source identity or time that goes backward, or by a change of input size. Skipped renderer submissions, however, do not restart the sequence of successful inferences.

Preparation validates the model package and the installed provider before it publishes native resource paths. The provider is portable and does not need an M5-specific DLSSMac binary. [Neural rendering, restoration and image upscaling](PROVIDERS.md#neural-rendering-restoration-and-image-upscaling) lists the provider's platform requirements and how translated processes reach it.

### Frame-generation rows

```js
{ id: "frames", kind: "frame-generation", enabled: true, method: "vt-interpolation",
  settings: { frameMultiplier: 2, keepStaticContent: true } }
```

A frame-generation row names the method that generates images and how many images it requests. Its `method` is a method from the [frame-generation table](PROVIDERS.md#frame-generation), or `auto` for [Automatic](PROVIDERS.md#automatic). The request itself is `frameMultiplier`, the ratio of displayed images to real frames. Each method's operation contract produces only certain multipliers, so validation accepts only those:

| Methods | `frameMultiplier` |
| --- | --- |
| `lsfg`, `mlx-interpolation`, `rife`, `vision-flow`, `auto` | 2, 3, 4 or 5 |
| `vt-interpolation` | 2 or 4 |
| `metalfx-image`, and the scene methods `metalfx`, `fsr3` and `xess` | 2 |

The remaining settings apply only to some methods. `keepStaticContent` adds the [static-content step](PROVIDERS.md#static-content) after an image-pair method and has no effect on scene methods; it is off by default for games and on by default for window graphics. An LSFG row also holds `lsfgMode` (`quality` or `performance`), `lsfgFp16` and `lsfgFlowScale` (0.25 to 1).

### Model inputs for image filters

Some image filters use a model, such as a depth estimator, and declare it as a typed model input. For such a row, the optional `settings.modelPath` is `null` for Automatic or the path of an explicit compatible package. The operation that the model performs, the row's `modelOperation`, comes from the validated filter descriptor and is not an editable plan field. The two operation lists differ in scope: `MODEL_OPERATIONS` includes scalar attachment models, while `NEURAL` holds only image and timeline operations.

Neural rows and filters with model inputs share one path for model selection, download, reservation while in use, permission checks for a running game and cancellation. When a row with an attachment model is prepared, the key that identifies its resources includes the resolved model path and operation, so changing the model or an input parameter invalidates the earlier preparation. Turning the row off keeps the saved selection and requests no inference.

### Sizing helpers

A schema 2 resize row can size the image for another row. Such a helper names its owner in `ownedBy`:

```js
{ id: "reduce", kind: "downsample", enabled: true, method: "bilinear",
  extent: { relativeTo: "presentation", factor: 0.5 }, settings: {},
  ownedBy: { id: "scale", role: "input" } }
```

`ownedBy` holds exactly the owner's row ID and a role. An `input` helper reduces the image before its owner, and a `fit` helper fits the owner's output afterward. These rules apply:

- Only `spatial`, `downsample` and `upscale` rows can be helpers.
- The owner is an unowned `shader`, `spatial`, `upscale` or `neural` row of the same plan, with at most one helper for each role.
- A source request made for an owner's input helper names that owner in `renderResolution.managedBy`.
- Row IDs never imply ownership, except in the ownership migration described below.

Validation reports a helper whose owner is missing, is itself a helper or cannot own helpers. It does not repair the plan.

Edits keep these rules as well: `effects/edit-operations.mjs` applies every plan edit as a pure operation, with these effects:

- Helpers and an owned source request follow their owner's enabled state, removal, position and implementation, including while the owner is off.
- An input helper owns the source request made for it, so removing the helper also removes that request.
- `clear` removes every row and owned request, and keeps a source request that was made on its own.
- Editing a helper directly, other than through its owner's fit size, turns it into an ordinary row.

Which helpers a row receives is decided only by the shared geometry classifier:

- An Upscale owner receives an input reduction and, at a fixed scale, a fit after it. Another source request, an explicit owner size or another reduction makes the sizing manual instead.
- A neural image row receives a 720-pixel processing input, except for decoded video. It also receives a fit when the chain has no other reduction or upscaler.
- A fixed pixel size is a Downsample and derives no helpers.
- A shader that replaces a row keeps the row's explicit factor or pixel size, even when that size gives the shader another resize type. A presentation fit or an automatic size takes the new slot's default instead.
- A fixed-scale model's fit uses a filter that works in both directions, so it follows the window whether the model's output is larger or smaller.
- Automatic fits favor MetalFX spatial upscaling when the GPU's support for it is confirmed. Manual and imported selections keep their settings and eligibility.

Imported shaders with the same declared geometry as included ones produce the same rows, types, helpers and source requests.

The ownership migration, `migrateOwnership`, is the one place where row IDs matter: it gives explicit ownership to the helpers of a schema 2 plan that follow the naming convention (`auto-scale-input-…`, `auto-scale-fit-…`, `auto-nr-input-…`, `auto-nr-fit-…`). In the process, it removes helpers whose owner is missing or cannot own them, and it keeps one helper for each role. It also disables the helpers of a disabled owner, moves each helper back to its side of the owner, and removes a source request whose `managedBy` owner is missing or disabled. Running the migration again changes nothing.

## Plan settings

Besides its rows, a plan holds a source request in `renderResolution`, output settings in `output` and the game's depth input in `depthInput`. [Source requests](FRAME_API.md#source-requests) lists the `renderResolution` values.

### Tone mapping

The tone-mapping policy decides how the final color conversion handles highlights. `output.toneMapping` accepts `auto`, `preserve`, `reinhard` or `pbr-neutral`, and a missing value selects Automatic; [Output tone mapping](FRAME_API.md#output-tone-mapping) describes what each policy does. An explicit policy works without any effect row, although the whole-graph **Graphics** switch still bypasses it. If the processor does not support a requested policy, preparation keeps it as pending output metadata, and independent rows continue on the older processor. Whether an image is scene-referred is decided from the actual image at the final color conversion.

### Output comparison

Comparison shows the processed result against its source. It is an output setting that both editor views share, separate from the effect rows: `output.comparison` selects `off`, `before`, `wipe` or `difference`, with a normalized `position` and a difference `gain` from 1 to 16. On the GPU, the comparison aligns the source image that the processor accepted with the processed result, in the same color domain and with the same alpha handling. That source can already contain the renderer's own processing or a native decoder prefix.

A graphics package that declares `comparisonAPI: 1` provides comparison for ordinary presentation and for file processing, and export uses the saved comparison choice through the same GPU helper. Comparison on its own needs the shared processor but loads no neural models or frame generator. When comparison is turned off, its options are hidden and the saved position and gain are kept.

### Presentation and pacing

The remaining `output` fields belong to presentation. They fall into the groups in this table, and [reading saved plans](#reading-saved-plans) validates each group on its own:

| Fields | Values | Behavior |
| --- | --- | --- |
| `motionClarity`, `subframes`, `duty`, `brightness` | `off`, `bfi` or `beam`; 2 to 8 subframes; a visible duty from 0.125 to 1; a brightness from 1 to 8 | [Motion clarity](README.md#motion-clarity) |
| `framePacing`, `targetFps`, `smoothCadence` | `fixed` or `adaptive`; a target from 30 to 240 frames per second; a boolean | [Frame generation](README.md#frame-generation) and [Timing](FRAME_API.md#timing) |
| `hud` | `off`, `compact` or `detailed` | [Performance overlay](FRAME_API.md#performance-overlay) |
| `frameRateCap` | 0 for no cap, or 10 to 1000 frames per second | [Source frame-rate cap](FRAME_API.md#source-frame-rate-cap) |
| `displaySync`, `drawableCount` | a boolean; 2 or 3 | [Presentation options](FRAME_API.md#presentation-options) |

Four of these fields, `hud`, `frameRateCap`, `displaySync` and `drawableCount`, need support from the running graphics package and frame source. The launcher publishes them only when both declare them, as [Native plan document](LIVE_UPDATES.md#native-plan-document) describes.

### Depth input

`depthInput` holds the game's ReShade depth-input definitions for `.fx` rows whose compiled program reads depth:

| Field | Definition |
| --- | --- |
| `reversed` | `RESHADE_DEPTH_INPUT_IS_REVERSED` |
| `logarithmic` | `RESHADE_DEPTH_INPUT_IS_LOGARITHMIC` |
| `farPlane` (1 to 1000000) | `RESHADE_DEPTH_LINEARIZATION_FAR_PLANE` |
| `multiplier` (0.001 to 1000) | `RESHADE_DEPTH_MULTIPLIER` |

Without a saved value, depth is not reversed and the other definitions keep each shader's own defaults; ReShade's defaults are linear depth, a far plane of 1000 and a multiplier of 1. A saved plan stores only the values that differ from these defaults, and an invalid saved value is skipped on its own.

When the graphics runtime reports `depthInputAPI: 1`, both editor views show these settings as **Depth input** on each qualifying row, and a change applies to every such row of the game. Because this setting belongs to the game, applying a preset and **Clear effects** keep it. Other shader formats, and filters that unproject depth with a projection supplied by the renderer, do not use these definitions.

### Adaptive processing size

Adaptive quality changes a Downsample row's working size to keep GPU processing within a time budget. Its settings are held in `output.adaptiveQuality`: `enabled`, `nodeId`, `budgetMs`, `minScale` and `maxScale`. The budget ranges from 0.25 to 1000 milliseconds, and the scale bounds range from 1/16 to 1, with the minimum no larger than the maximum. The policy acts on its target row through that row's existing **Output size** options, and its bounds multiply the row's saved extent. These working sizes are temporary: they never rewrite the saved dimensions, the output dimensions or the frame timestamps, and turning the policy off restores the saved extent. If the target is removed or disabled, the policy stays pending while the other rows run normally.

While the game runs, the shared `EffectQualitySession` receives the durations of completed GPU jobs and applies new sizes through the ordinary asynchronous graph replacement. It keeps the accepted output during a replacement, and it discards stale decisions after a plan change, a seek or Off.

Each measurement must cover all the work the policy affects:

- Provider `gpuWorkScope` metadata identifies work encoded in the caller's command buffer and work on external queues. An external operation that is not measured leaves the policy pending.
- libplacebo supplies optional versioned GPU timing functions without changing the shader-node ABI. Its render-queue timestamps cover the affected operation.
- All affected external intervals must match before the session counts one sample for a real input. Unrelated rows, stale intervals and caller waits are excluded.

Window processing and file export use the same policy and status fields.

## Reading saved plans

Saved graphics are read only through `effects/stored-plan.js`. The reader never replaces a saved plan with another plan or with v0.4.0 fields:

- An absent plan is the empty plan.
- A plan that validates is used as saved.
- A plan that does not validate as a whole is read row by row. Each row, the source request, each group of output settings and the depth input is validated on its own. A part that cannot be read is left out of the plan that runs and reported in a notice, and a helper whose owner was left out is left out too. The saved value stays unchanged until the next edit saves the readable plan.
- A plan from a newer schema (`GRAPHICS_STORED_PLAN_NEWER`) or with an unreadable top-level structure (`GRAPHICS_STORED_PLAN_INVALID`) cannot be read at all. The top-level structure is the schema, the mode, the row list, the master switch, the set of plan fields and the 4 MiB size limit. Such a plan is kept byte for byte, editing is blocked until **Clear effects**, and launches bypass shared graphics.

Underneath this reader, the plan model checks whole plans. `inspect(value)` returns `{plan: null}` for an absent value, `{plan}` for a valid one, and otherwise `{error: {code, message}}`, where the code is `GRAPHICS_PLAN_NEWER` for a later schema and `GRAPHICS_PLAN_INVALID` otherwise. `normalize(value)` returns the plan or `null`, and throws the same error, with its `code`, for an invalid plan. `salvage(value)` performs the row-by-row reading. The Node module applies its settings and provider checks through the same results.

### Upgrading v0.4.0 settings

MacLauncher v0.4.0 saved Simple settings in the record's `reshade` and `graphics` fields, and Advanced settings as schema 1 plans. Such records are converted when they are first read, through `src/core/backcompat/record-conversions.js` and `graphics-record-upgrade.js`, so the app, its backend, shortcuts and command-line launches all use the same `effects` plan. Records already in the current format skip this conversion. For an older record, one atomic write stores the equivalent plan and removes the old fields. If that write fails, the converted choices remain active in memory, and identical reads in the same process do not repeat the conversion or the write. Each selection is converted on its own: a missing file or retired method leaves its row off with a notice, or produces only a notice when no row can hold it.

A schema 1 plan is kept when it validates, and otherwise rebuilt from the fields and rows that still validate. Known reduction and enlargement rows migrate to schema 2 without being reordered, and ambiguous fit rows keep their fit meaning. The old `method: "downsample"` becomes an explicit Downsample row that uses Bilinear.

v0.4.0 kept Simple neural settings in `graphics`:

| Field | Meaning |
| --- | --- |
| `neuralMethod` | `off` (the default) or `mlx-dlss`. |
| `neuralModelPath` | A local model package, or `null`. |
| `neuralInputHeight`, `neuralInputScale` | An explicit pixel height or window-relative scale, which keeps its meaning. With neither set, games start at a fixed 540-pixel height, and native decoded video keeps its input dimensions. |
| `neuralIntensity` | Defaults to 1. |
| `neuralTemporal` | Defaults to false. |

These neural settings convert to explicit reduction, neural and final-fit rows. A historical automatic Downsample extent becomes `{height: 540}`, which replaces any size fields saved beside it, and no size that depends on the window is inferred. Existing manual factors, pixel sizes and row order stay intact.

Whether the conversion also requests a smaller source depends on the host. When the game's engine controls its source size, neural conversion adds no source request, so the engine-composited frame stays complete rather than having its 3D scene scaled and the composite reduced again. On hosts with a compatible full-frame source adapter, by contrast, the same fixed-height request can reduce the game's allocation before effects run. A processing reduction alone does not lower the game's rendering cost.

v0.4.0 also kept a spatial shader in `graphics.spatialShader`, which held a shader selection, or `null`. That selection excluded a native `spatialMethod`, while the appearance shader in `reshade` stayed independent. On upgrade, it becomes an ordinary shader row at the spatial stage, after reconstruction and before frame generation. The shader's intrinsic dimensions stay intact, and an automatic fit follows when needed. Its source request follows the same native, virtual and completed-frame fallback as other spatial methods. No provider or virtual window is chosen from a neural description alone.

The upgraded Simple selections are ordered by `composeSimple(entry, {shaderFacts})`, which uses their actual input requirements and declared shader traits:

1. Shaders that read source depth and motion come before geometry changes.
2. Imported reconstruction or resizing shaders come before the final spatial fit and frame generation.
3. Ordinary display shaders follow frame generation.

The upgrade saves this order in the plan, and preparation runs every plan in its saved order. `fromLegacy`, however, keeps its literal before/after conversion. A video record's mpv filter selection stays with mpv's own scaler, as described in [native video prefixes](SHADERS_AND_MEDIA.md#native-video-prefixes).

## Graphics catalog

Each game has a graphics catalog that lists every implementation the editor can place in a row, with its availability for that game. It combines the selected processor's capabilities with the actual input metadata of the game's frame source. Simple, Advanced and the **Add effect…** chooser read the same prepared catalog. Native builds advertise ordered execution through `features.graphics.effectPlanAPI: 1`, and `effectPlanKinds` lists the row kinds that the graphics processor parses.

### Contracts

Each catalog row states what it consumes and produces. Its `inputContract` and `outputContract` describe its data domains, required scene guides (renderer data such as depth, motion and camera parameters), output extent and rate, and history, while a provider adapter supplies the algorithm itself. `effects/contracts.mjs` supplies the shared type classifier and implementation matching. Search tags such as color, CRT and restoration are independent of these contracts, so same-size neural filters and fixed-scale CNN upscalers keep their actual output geometry. The library's Type filter uses the same classifier, and [shader output sizing](SHADERS_AND_MEDIA.md#shader-output-sizing) describes how it reads a shader's geometry.

Which scene inputs a row needs is determined by a compiled FX technique's texture semantics or a compiled filter's typed declaration. When depth, motion, camera data or matrices are missing, the affected row stays pending while compatible image rows continue. All rows run on the common executor, which handles frame handoff, failure isolation and GPU resource lifetime, and frame generators also share the presenter and its display timeline.

### Menu order

Each catalog row's `recommendationRank` sets its tier in menus:

| Rank | Rows |
| --- | --- |
| 0 | The suggested default: MetalFX where the GPU supports the operation. |
| 1 | Common choices: FSR 1, bilinear, bicubic, nearest neighbor, area, FSR 3, Lossless Scaling Frame Generation, CAS, Sharpen, CRT and Colour. |
| 2 | Ordinary rows. |
| 3 | Specialized variants: libplacebo kernels other than Lanczos, EWA Lanczos, Spline (3 taps), Mitchell-Netravali and Catmull-Rom, and installed collection files that their collection does not name. |

Ranks 0 and 1 appear first, under **Recommended**. Rank 3 appears after **More**, or in search results, under its group's heading after the group's other rows. A selected row is always listed.

Rows that need scene inputs are also placed according to the game's frame source. When that source declares its inputs, a row that needs an input the source omits carries `inputsAbsent`, a reason that names the missing inputs. Such a row is listed under **Needs scene inputs** after the ordinary groups and stays selectable, although methods that the engine runs itself are exempt. A frame source can also declare `imageOnly`, as video playback does, to state that it never supplies scene inputs. For that source, a row that needs one is unavailable instead: it carries `sourceUnsupported` and a reason naming the missing inputs, and it is left out of the menus. An unavailable built-in method of this kind names a working method of the same kind in `replacement` when one exists, with MetalFX image interpolation preferred for frame generation. In Simple, a slot whose methods are all left out is hidden unless the plan already holds a row for it.

Menus group ordinary shaders by purpose. For this, shader packs and built-in presets declare a `purpose` for each ordinary shader: Sharpen, Colour and tone, CRT and retro, Anti-aliasing and blur, Lighting and lens, Restoration, Depth, Accessibility or Artistic, and effects that read renderer depth take Depth. The groups appear in that order.

Menus also shorten long effect names. A pack effect whose label begins with the pack's name carries that name as its `family`, and menus leave the family out of the displayed name when the effect type or menu heading already names it; search still matches it. Stored identifiers, library names and preset references keep the full label. Availability reasons appear as a secondary note beside the name.

Large implementation menus search names and descriptive tags locally, with **Off** and **Manage filters…** still available beside the results, and searching does not change the saved plan.

### Catalog loading

The catalog is built only while a view needs it. A launcher view that shows graphics settings requests it with `requestGraphicsCatalog({open: true, revision})` while it is open, and releases it with `{open: false}`. The main process builds the catalog (`ReShade.getState`) only while some view holds a request, and sends each new catalog revision through `onGraphicsCatalog`. Closed Graphics sections, library views without an open editor and launches build no catalog.

A view's first request reads the sources again and compares the result, so a shader file edited in place is found when an editor opens. After that, discovery is reused until something relevant changes. The main process derives an inventory revision from the installed runtimes and models, the graphics settings, the hardware snapshot, explicit filter library changes and such in-place edits. `Effects.info` and `Effects.templates` reuse their discovery, catalog rows and templates for one inventory revision and saved plan revision, while callers without a revision read them again. `Effects.info` holds the full installed catalog for the editor but no templates.

Each catalog section is read on its own: models, neural models, shader packs, downloadable shader collections, the neural provider and graphics capabilities. A section that cannot be read keeps its empty default and adds a notice with its reason to the catalog's `notices`, and the other sections stay available. Within a section, an effect or preset whose metadata cannot be read is listed as an unavailable row with its reason. Only an unreadable core runtime record, however, makes the whole catalog unavailable. In the editor, a row that fails to render is replaced by its reason and a Remove action, and the other rows render.

### Templates

The graphics menu also offers contextual templates, which are ready-made plans for the game. `getGameEffectTemplates(gamePath)` reads them when the menu opens, and `Effects.templates` returns each template with a validated plan, its availability and a setup reason. The reconstruction template is built by `reconstructionPreset`, which fills manual reduction, neural, spatial and frame-generation rows with the current local model settings, so the shared built-in catalog stores no machine-specific model paths.

## Preset storage

Presets are named snapshots of Advanced plans that can be applied to games. They are stored in `graphics/effects-presets.json` under the application data directory, and this store holds up to 128 named snapshots within a 16 MiB metadata limit. It uses the shared effects-plan validator, atomic writes and revision checks for edits from several windows.

An unreadable preset file blocks preset edits and is never replaced. In a readable file, each preset is read on its own. A preset with unreadable rows is listed with its readable rows and a notice for each skipped row. A preset that cannot be read at all is not listed, and `getEffectsPresetNotices()` reports it. Saving or removing another preset keeps the stored bytes of both.

Storing a preset does not prepare or publish a running plan. Applying a preset copies its plan into the game record and uses the ordinary per-game preparation, including resource, ordering and renderer validation. The game keeps no link to the preset, so later preset edits do not change the game.

## Launcher API

The launcher's preload script exposes these graphics methods to the renderer:

| Method | Behavior |
| --- | --- |
| `getGameEffects(gamePath)` | Returns the readable saved plan, the game's current catalog, source-resolution capabilities, native binding timing, `notices` and the [graphics status](STATUS_AND_DELIVERY.md#graphics-status). An unreadable saved plan is returned as `graphicsPlanError`, with an empty editor plan. |
| `getGameEffectTemplates(gamePath)` | Returns the contextual templates for the graphics menu, read when the menu opens. |
| `requestGraphicsCatalog({open, revision})`, `onGraphicsCatalog(callback)` | Declare and release a view's need for the graphics catalog, and receive each new catalog revision while the request is held. See [catalog loading](#catalog-loading). |
| `getGameEffectParameters(gamePath, nodeId, draftPlan?)` | Describes a shader's parameters without saving or activating the draft. |
| `pickGameEffectFile(gamePath, kind?, operation?)` | Selects a local shader or, with `kind: "neural-model"`, a compatible installed model or an original model file to import. An import returns the path of the stored copy. An expected `operation` validates the package before it is attached to a row. Cancelling changes no settings. |
| `setGameEffects(gamePath, plan, request?)` | Applies the edit to the saved plan, rebasing it when `request.basePlan` names the plan it was made from. Validates the result once and saves it. A row that cannot be read is left out and listed in `notices`, and the readable rows are saved and published. A running game with live graphics editing receives the prepared plan; other games use it at the next launch. Returns the saved plan and its revision. A plan whose top-level structure cannot be read is rejected, and an unreadable saved plan rejects edits until it is cleared. |
| `resetGameEffects(gamePath)` | Clears the chain and its upgrade notices. Changing the editor view does not call it. |
| `getGraphicsStatus(gamePath)`, `onGraphicsStatus(callback)` | Read and observe the game's [graphics status](STATUS_AND_DELIVERY.md#graphics-status). |
| `listEffectsPresets()` | Lists the Advanced plan snapshots in the local preset library. |
| `getEffectsPresetNotices()` | Lists a notice for each saved preset that could not be read. Such presets stay in the library file. |
| `saveEffectsPreset({ id?, name, plan, updatedAt? })` | Creates a snapshot, or updates the matching revision, without changing games. |
| `deleteEffectsPreset(id, updatedAt)` | Removes the matching revision. Copies already applied to games stay. |
| `getEffectsPresetEditor(plan?)` | Provides the shared catalog and an inactive plan for the preset editor in Settings. |
| `getEffectsPresetParameters(nodeId, plan)` | Describes the parameters of a preset draft without activating it. |
| `pickEffectsPresetFile(kind?)` | Uses the same local shader and model chooser without a game record. |

Each notice is `{message, rowId?, dropped?}`. `rowId` names a row that an upgrade kept off in the plan, and `dropped: true` marks a saved row, source request or output setting that is missing from the plan because it could not be read. Library records carry the same notices as `effectsNotices`, with the readable plan as `effects`.

Switching between Simple and Advanced keeps the plan, its row order and the saved choices. Reset keeps unrelated game settings, saves, accounts, source files and the shared filter library. Removing or bypassing a shader never deletes its original file. [Failures and fallbacks](LIVE_UPDATES.md#failures-and-fallbacks) describes what happens when a saved row cannot run.

## Ordering and scene boundaries

Each enabled row receives the previous row's output. Preparation checks the order row by row against the earlier rows that run. A row that breaks the order, including through requirements that only the compiler finds, is bypassed with its reason, and the other rows keep their places. The planner and the per-frame checks enforce each row's actual required inputs without moving saved rows or fabricating data.

### Scene guides

Scene guides match an image only while its coordinates are known. A row that preserves coordinates therefore keeps the matching guides, and with `sceneGuideTransformAPI: 1`, known crop and resize transforms also normalize real depth, motion, jitter, masks, exposure and the available camera metadata for the next scene provider. Motion at output resolution and texture subregions keep their declared conventions. Reconstructed depth stays alive through its actual GPU use, including a later presentation command buffer. Older processors keep their requirement for scene inputs at the original extent.

Generated images never gain renderer guides, and a shader with an unknown coordinate transform cannot establish which guide pixels match its output.

### Derived inputs

Derived data follows the input requirements of the enabled rows. Guide normalization, estimators, plane conversion and model preparation that no enabled row uses stay idle. Existing matching inputs and intermediate results from the same generation are reused, and a relevant image or geometry change invalidates the derived result.

### Sizes and presentation

Spatial output-size controls apply to every supported frame adapter. When the chain's last output has other dimensions than the presentation target, a final fit scales it to the target without changing the game renderer's allocation. Processing extents are sampling grids and keep the game's logical mapping of image to window. A grid with different horizontal and vertical sampling densities still fills that mapped target. The size controls never declare a crop or a change of display aspect.

### Original MetalFX temporal output

When a frame source has no shared scene frame, a temporal row can still run through the original MetalFX adapter, whose ordered temporal scope `features.graphics.effectPlanTemporal` declares. The adapter needs a full output that covers the exact acquired drawable, and a classic command buffer. Besides the method's scene inputs, the renderer's input metadata must therefore identify `temporalSource: "original-metalfx"`, `temporalOutput: "acquired-drawable"` and `commandBuffer: "classic"`. These facts must come from the renderer integration, because depth and motion alone do not establish which output the scaler owns.

A one-use binding identifies the original scene frame, command buffer and output texture, and only the remaining effect rows run at presentation. Offscreen, subrectangle and ambiguous output paths, however, keep the original scaler. Both editor views select the same provider input contract.

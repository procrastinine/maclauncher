# Preparation, live switching and resource ownership

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

A replacement is prepared independently of the accepted execution. Publication, source allocation, GPU completion and physical presentation retain distinct identities and lifetimes.

[Background preparation and paused content](#background-preparation-and-paused-content) · [Demand analysis and prepared resources](#demand-analysis-and-prepared-resources) · [Dormant activation and launch binding](#dormant-activation-and-launch-binding) · [Atomic live publication and model leases](#atomic-live-publication-and-model-leases) · [Preparation and per-stage failure behavior](#preparation-and-per-stage-failure-behavior) · [Retained rows and native publication](#retained-rows-and-native-publication)

## Background preparation and paused content

The native planner prepares a replacement graph on a worker. Its identity
includes the requested revision, device/queue, image geometry and format,
origin, opacity/color and scene-input contract. Shader compilation, model
construction and resource allocation belong to this preparation. A completed
job is adopted only when its request and frame contract still match. A newer
selection or Off retires obsolete work without publishing its result.

Producer, detached-processing and final-presentation queues have distinct
ownership. Each row is prepared for the queue used by its actual phase, including
filters after frame generation or display subframes. Changing the final queue
replaces affected image resources while preserving compatible generator history.

While preparation is pending, a compatible accepted execution or completed image
remains available. The planner retains resources for unchanged stages and
prepares affected suffixes independently. A changed contract is not acknowledged
by an older completed frame. Busy admission and a terminal provider failure
retain distinct recovery behavior, so repeated submissions do not alternate
between mismatched old and new output.

Each row has two input identities. The exact identity covers every upstream
control and keys cached results and redraws. The contract identity covers the
image size, format and color, the upstream row identities, shaders and
switches, but not upstream numeric controls. A history-owning row with an
unchanged contract keeps its prepared node, resources and history when only an
upstream control changes: temporal reconstruction, frame generation, histogram
exposure, estimated depth range and in-place shader history continue, while
their exact caches refresh. A changed contract recreates the row and starts its
history again.

`preparationNotificationAPI: 1` supplies
`rsObserveFramePresenterPreparation`. Its versioned observer retains callback
context through queued notices and unregistering. A readiness notice posts to
the producer queue; it does not synchronously render, accept a revision or
create a new source frame. A paused/static producer retries its retained image
with the same content identity. Parameter redraw and real content progression
remain separate, preserving temporal and interpolation history.

## Demand analysis and prepared resources

`ReShade.executionRequirements(entry, { sourceSupport, diagnostics, activation })` is a pure
settings calculation implemented in `effects/execution-requirements`. It
returns a `mode` (`none`, `activation` or `processing`), `needed`, selected `methods`, shader rows, the source request and a
`components` list with each component's necessity and reason. Shader processing,
spatial and temporal filters, neural rendering, frame generation, source
controls, virtual presentation and explicit diagnostics determine processor
and presentation requirements. LS1/LSFG alone require Lossless Scaling models;
selected FSR temporal methods require their own providers. The calculation
performs no file reads, provider discovery, model inspection, shader parsing or
GPU work. Dormant activation is independent of processor and presentation
requirements. It permits later live changes without enabling any image stage.
The bound launch records it as `launch.json.executionRequirements`.

Launch preparation reads the selected runtime's declaration without building
the Settings catalog of every installed shader pack and model. Payload
verification follows the selected components: the shared core, required shader
provider, selected temporal provider or neural runtime. Verified files are
cached by file identity and their declared checksum, size, permissions and
architecture; at launch a changed file is verified again. Edit preparation
reuses a file verified earlier in the same launcher process against the same
declared row without checking its identity again, and a new runtime directory
or declared row is verified on first use. A file that fails verification is
not reused. The runtime declaration (`runtime.json`) is parsed once per file
identity. Optional component selection does not bypass its provider's platform
or resource validation.
Dormant activation also verifies the core library and its required closure.
An unavailable or damaged optional bridge is omitted before the game starts.

Ordered preparation calculates those requirements after the module's native
renderer routing. It resolves only the remaining selected shader IDs, discovers
the neural provider only for enabled neural rows, and reads Lossless Scaling
model metadata only for LS1 or LSFG. Selected method capabilities omit unrelated
provider discovery. `Effects.info` retains the full installed catalog for the
editor; custom shader rows retain independent compiler and resource validation.

Editor catalogs follow demand. A launcher view that shows graphics settings
requests the catalog through `requestGraphicsCatalog({open: true, revision})`
while it is open and releases it with `{open: false}`; the main process builds
`ReShade.getState` only while some view holds a request and sends each new
catalog revision through `onGraphicsCatalog`. Closed Graphics sections, library
views without an open editor and launches build no catalog. A view's first
request reads the sources again and compares the result, so a shader file
edited in place is found when an editor opens. The main process derives an
inventory revision from the runtime and model inventories, the graphics
settings, the hardware snapshot, explicit filter library changes and such
in-place edits. `Effects.info` and `Effects.templates` reuse their discovery,
catalog rows and templates for one inventory revision and saved plan revision;
callers without a revision read them again. `Effects.info` does not include
templates: `getGameEffectTemplates(gamePath)` reads them when the graphics menu
opens.

Each catalog section (models, neural models, shader packs, managed shader
collections, the neural provider and graphics capabilities) is read on its
own. A section that cannot be read keeps its empty default and adds a notice
with its reason to the catalog's `notices`; the other sections stay available. Within
a section, an effect or preset whose metadata cannot be read is listed as an
unavailable row with its reason. Only an unreadable core runtime record makes
the whole catalog unavailable. In the editor, a row that fails to render is
replaced by its reason and a Remove action; the other rows render.

Prepared shader revisions are reused when the selection, runtime root and
process architecture match and the prepared resource remains present. Custom
file identity includes its filesystem identity, size and modification times
and the identities of its dependencies. Launches and parameter updates reuse
the prepared revision of an unchanged included, registered or custom
selection.
Registered sources track filesystem identity and change time, so replacing a
file invalidates its prepared revision even when its size and modification
time are preserved.
FX validation and resource metadata use the frozen preprocessed source that is
published, so edits to an original file during preparation do not change the
program described by that revision.
The entry source is frozen before reading its color policy and preprocessing;
its original filename and include search directories remain available. Custom
rows retain their exact file's coordinate metadata independently of the shared
Custom selector. Executable requirements still come from the prepared program.
The offline FX compiler accepts `--prepare EFFECT.fx PREPARED.fx`, followed by
`PREPARED.fx OUTPUT_DIRECTORY` for full validation. Its output includes GLSL and
Metal shaders, `textures.json` image-source names, `uniforms.json` parameter
metadata and `requirements.json` scene-input requirements for each technique.
Runtime staging checks this CPU-only contract before publishing a compiler.
Provider availability is checked when reusing a revision. UI discovery metadata
does not form part of the compiler identity. For an FX program that reads
depth, the game's non-default depth-input definitions do; a change prepares
those rows again, while rows without depth keep their revisions.

## Dormant activation and launch binding

Shared presentation hosts prepare the included processor and an empty effect
plan even when optional effects are off. This allows Simple and Advanced effects
to be enabled during play. Unadapted hosts retain their unfiltered launch path.
Dormant live controls install hooks without requesting image processing. Quartz
capture and Metal framebuffer access follow the active plan or live controls;
an empty selection leaves original drawing in place. CRT-only settings request
the shader path without preparing scaling, generation or model resources.
Dormant drawable requests forward directly to the original renderer before
device discovery or command-queue setup. Remote layer hooks defer image-class
probes and publisher state until processing is needed. Existing owned output
retains its normal retirement path when effects are disabled.
When no separate output is active, size-preserving ReShadeFX can process a
readable native Metal drawable directly, including during native window
resizing. Imported shader geometry, reconstruction, frame generation and
explicit source scaling retain their separate presentation requirements.
Owned SDR output validates the source image format and readability before
creating a presentation view; unsupported conversions retain the original
renderer. CGL and remote surfaces keep their respective presentation adapters.
Live activation reserves the two managed graphics-model paths without creating
their directories or inspecting models. A neural library path from the included
provider layout is authorized without inspecting or loading that provider.
Selecting a neural row validates compatibility, the provider inventory and model
contents before publication; imported managed models can therefore be selected
during play. Optional source-control, coordinated-presentation and future-model
channels are prepared independently. An unavailable channel leaves already
prepared graphics stages available and preserves the process architecture and
frame-adapter metadata. No model weights are loaded for an empty plan.

Installed temporal provider paths belong to the immutable launch selection and
can be reserved for later live use without loading their libraries or creating
GPU resources. The currently selected algorithm is independent of that resource
reservation. Selecting another provider validates its resources and required
frame inputs; the producer's original API does not form an algorithm allowlist.

After optional preparation produces a child's environment, the launch core
binds its actual PID once through `ReShade.bindLaunchProcess`. Launches without
the processor do not read or rewrite an earlier graphics record. Main-process
controls supply `runningPids` from the current sessions; live preparation and
validation require a matching `launch.json.pid`. Expired or absent bindings
save canonical preferences for the next launch without compiling or publishing
a live plan. After asynchronous preparation, plan, shader-selection and control
publication rechecks the same launch identity and active session. Stopped or
replaced sessions retain the saved preferences without replacing the current
launch's files. Models outside the launch's authorized stores and selected files,
neural-provider changes, and temporal methods requiring different scene inputs
remain next-launch settings. Callers omitting `runningPids` retain the standalone API contract.
The existing `graphicsInputs` inspection response includes `graphicsLive` for
Simple controls, without model or provider discovery for that binding check.

## Atomic live publication and model leases

Live callers can create `ReShade.createPublication({isCurrent})` and pass it as
`options.publication` during validation and preparation. Immutable shader
revisions are prepared immediately; accepted plans, selections and control
files remain unchanged. A renderer update can use the prepared resources before
calling the synchronous `publication.commit()`. Commit revalidates the original
launch and accepted file bytes, publishes complete documents, and writes the
effect plan after its selections and controls. Each file replacement is atomic;
the files are not a shared native snapshot. `rollback()` discards uncommitted
changes or restores committed bytes only while the same launch and candidate
still own every affected file. `deferred` indicates a next-launch setting.
`onRollback(callback)` registers an in-process effect of preparation that a
rollback reverses together with the files.

Each native process reads the effect plan on its own serial queue. A directory
watcher observes replacement by rename, a file watcher observes in-place writes
and a safety tick covers missed events. A read that fails keeps the last
accepted plan and reports the error; it is retried with a bounded backoff of
50 ms to 2 s, and the watcher is armed again when its directory is replaced or
could not be opened. Reading an unchanged file again clears an earlier read
error. A process whose sandbox refuses the plan path, such as a Chromium helper
after its sandbox engages, keeps the plan it read before and cannot follow
later edits.

A live edit prepares only the rows it changes. Within one launch, an included
or pack shader row and a stage row without a Lossless Scaling model reuse their
earlier prepared result when the row, its capabilities, the runtime root, host,
architecture, frame inputs and graphics settings are unchanged, in any position
in the chain; ordering is still checked for every row. Custom and filter library
shaders, managed collections, shader model operations, neural and XeSS rows,
Lossless Scaling model rows and forced shader preparation are prepared on every
edit. A new launch prepares every row again.

The main process keeps these prepared rows in
`graphics/live-prepared-rows.json` in the application data directory, so a
restarted launcher reuses them for a game that is still running. The file holds
at most 16 plan files of 64 rows each and up to 8 MiB, and is replaced
atomically. A stored row is used only for the same launch, the same preparation
code (a digest of the preparation modules) and an existing compiled file. A
file that cannot be read is treated as empty, and its rows are prepared again.

Managed model access acquired for a live candidate belongs to that preparation.
Rejection or cancellation before publication releases its new reservations while
preserving access already held by the running session. Once publication starts,
the session retains candidate access through process retirement; restoring files
does not establish that asynchronous native consumers have finished.

Shader parameter saves can include an `expectedSelection` alongside the patch.
The serialized setter checks the selected preset, custom source and chain order
before preparation. Queued edits from earlier shader controls cannot replace
parameters belonging to a newly selected shader.
Graphics edits retain their order for each game. Leaving an unedited Advanced
preview preserves Simple settings without a runtime update. Stop and resetting
an Advanced chain cancel pending shared graphics preparation; subsequent edits wait for cleanup
and restoration of the accepted settings. Independent partial edits retain
their order. A cancelled preparation cannot publish a later revision.

## Preparation and per-stage failure behavior

`src/modules/shared/effects/plan.mjs` is the browser-safe model.
`plan.js` adds native settings validation and catalog construction.
`runtime.js` prepares immutable shader resources and publishes the native plan.
Preparation returns the requested editor `plan` and a separate `appliedPlan`.
The applied source-resolution request contains the size and optional source
method emitted at launch. Live preparation reports that existing allocation;
unavailable or changed source requests remain in the editor plan. Automatic source reduction is removed when its scaling or
reconstruction stages are unavailable, while manual Advanced requests retain
their saved settings.
Live model defaults resolve to a compatible identity already bound by the
running process when one exists. Otherwise the compatible managed default is
validated inside the process's authorized model store. Explicit managed model
selections can change during play; older sessions without store grants retain
their original model bindings until the next launch.
Ordered temporal edits retain their actual scene-input connection and admitted
processor resources while selecting compatible providers. Neural edits retain
the provider library and can select validated models within the granted stores.
`composeSimple(entry, {shaderFacts})` orders Simple selections by actual input
requirements and declared shader traits. Source depth and motion shaders
precede geometry changes; imported reconstruction or resizing shaders precede
final spatial fitting and frame generation; ordinary display shaders follow frame
generation. The one-time v0.4.0 upgrade stores this order in the saved plan, and
preparation runs every saved plan in its saved order. Scene requirements that
only the compiler reports, such as those of a custom FX file, do not move a
row; a row whose compiled requirements break the order is bypassed with its
reason. `fromLegacy` keeps its literal before/after conversion.
`Effects.templates` returns contextual templates with a validated plan,
availability and a setup reason. `reconstructionPreset` carries current local model settings
into manual reduction, neural, spatial and frame-generation rows rather than
storing machine-specific model paths in a shared built-in catalog.
The main process serializes edits per game and saves only successful changes.
Ordering is checked row by row in every preparation; a row that breaks it is
bypassed with its reason. At launch and in a running game, an unavailable or
incompatible row, or one whose shader, resources or compiler fail, is bypassed
too, while independent supported stages and the saved request remain; the
bypassed row's graphics status names its reason, and later edits prepare it
again. The check of a stopped game's edit reports an unavailable row instead.
A source request managed by a bypassed row is removed with it. A live edit is
rejected as a whole only when its plan cannot be read or its publication
fails, and the running game then keeps its last accepted chain. Export
preparation validates the readable rows strictly.
The independent `Effects.prepare({effects}, {fallback: true})` API provides the
same per-row launch fallback for callers that request it explicitly.
Successful standalone Simple methods retain their original runtime path. When
native graphics preparation fails, a supported ordered processor can prepare
the compatible rows instead. Temporal stages still require their original scene
inputs; fallback never invents depth or motion data. Cancellation is propagated.
`preparationStatus` describes requested, applied and skipped shared stages and
requested versus applied source sizing. `launch.json` stores it as
`graphicsPreparation`; `graphicsWarnings` contains structured `{id, kind, method,
reason}` entries for skipped rows and for saved parts that could not be read,
with a readable feature name in each reason. The launcher displays these warnings for the matching game
process. If preparation fails before a graphics publication exists, the launch
result carries a separate warning through backend IPC to the inspector. These
warnings do not change the saved settings or turn a successful game launch into
a failure. Preparation status describes resource preparation, not completed neural
inference or display presentation. A non-busy per-frame provider failure fits
that row's retained input across its complete output before independent later
stages continue. Partial writes from a failed stage are overwritten. A busy
provider retains the previous complete image instead of mixing it with a fresh
source frame.

## Retained rows and native publication

For live ordered edits, `launch-binding.nodeUnavailableReason` classifies each
row against the current process's graphics and model bindings. `effects/live-plan`
projects unavailable replacements onto the previous immutable native rows, or
leaves a newly unavailable row disabled, while compatible rows remain eligible
for the same atomic publication. Both requested and effective ordering are
checked row by row. A retained model row is not prepared again from the future model
selection. Edits with no independently usable enabled stage retain the previous
whole-publication deferral. Compiler failures, cancellation and stale launches
continue to reject the candidate publication.

A live edit that selects a model operation without a compatible installed
model leaves that row pending while the other rows publish. The preparation
names the operation's curated source, and the graphics status owner asks for
consent once per source, for every game waiting on it. The request fails
closed: a declined, closed or superseded dialog downloads nothing. A consented
download runs through the model manager's own setup action, shares progress
and cancellation with Runtimes and joins a download of the same source that is
already running. After installation, the current desired plan is prepared
again, so the row activates in the running game when its launch binding accepts
newly installed models (`launch-binding.acceptsNeuralModels`); otherwise the
row reports that it applies at the next launch. A declined, cancelled or failed
download is not requested again until that row's selection changes.

The saved plan remains the complete requested plan. A successful live
publication also stores `graphicsLivePreparation` in its matching launch record,
with the prepared revision, requested and applied rows, and pending reasons.
Resource retention for partial live edits requires an explicit native resource
acknowledgement for the same launch. A bounded history of four immutable native
documents keeps that accepted graph available if a newer published candidate
was rejected. Missing, stale or conflicting acknowledgements defer the partial
edit; ordinary supported live edits do not depend on status availability.
`runtime-status.acquireAccepted` reads that acknowledgment during the edit without
an open status panel. It uses a short scoped lease and an asynchronous wait,
bounded to 2.5 seconds or 5 seconds for a selected neural stage. Cancellation
and launch changes interrupt the wait. The prior lease is restored unless
another consumer renewed it. A timeout preserves the current graph and leaves
the request pending; it does not imply a restart requirement.

An untouched dormant activation may prepare independent new stages without
retaining old resources. This requires the exact current launch, its original
empty document, original Off controls and no earlier graphics preparation
or document history. A new unavailable generator can then remain pending while
a compatible shader is prepared. Previously active resources still require
explicit native acceptance. Supported edits, Off and requests with no
independent usable stage do not acquire this lease.
This is preparation state; native completion and presentation remain separate
observations.

The native plan uses `RESHADE_EFFECT_PLAN`, a private JSON file containing a
revision, mode and ordered `nodes`. Advanced mode with no enabled nodes and no
output processing is a pass-through chain, which native code acknowledges with
its revision like any other publication. Clear effects and a launch without
processing publish the empty advanced document (`Effects.emptyDocument`).
Updates publish atomically. One native reader per game process parses each
update once, when the file changes, and every consumer reads its immutable
snapshot. A document that cannot be read, whose envelope is invalid or that uses
a newer schema is rejected as a whole; the last accepted plan keeps running and
the error is reported. Within a readable document each row is validated on its
own: an invalid or unsupported row stays in place as a disabled row, its reason
is logged and reported as a bypassed stage, and the valid rows run. An invalid
output block falls back to the default output settings. Shader resources are
initialized before replacing a working execution chain.
Prepared FX bundles resolve frame dimensions for each native stage and again
when that stage's input size changes.

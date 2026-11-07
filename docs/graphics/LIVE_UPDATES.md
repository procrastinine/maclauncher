# Preparation and live updates

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

A saved effects plan reaches a game at launch and, while the game runs, through live edits. Either way, the launcher and the game's graphics processor prepare the new plan's resources in the background and then publish it, which makes it the plan the running game uses. Meanwhile, the running chain keeps working until its replacement is ready. Publication, source allocation, GPU completion and physical presentation are separate events with their own identities and lifetimes.

This page describes how preparation decides what a plan needs, how prepared resources are reused, how a launch is bound to its process, how live edits are published and what happens when part of a plan cannot run. [Effects plans](EFFECT_PLANS.md) describes the plan itself, and [status and delivery](STATUS_AND_DELIVERY.md) describes how the editor observes the result.

[Demand analysis](#demand-analysis) · [Shader preparation and reuse](#shader-preparation-and-reuse) · [Background preparation in the game](#background-preparation-in-the-game) · [Dormant activation](#dormant-activation) · [Launch binding](#launch-binding) · [Live publication](#live-publication) · [Partial live edits](#partial-live-edits) · [Failures and fallbacks](#failures-and-fallbacks) · [Native plan document](#native-plan-document)

## Demand analysis

Before anything is prepared, MacLauncher works out what a plan needs from its settings alone. This demand analysis is done by `ReShade.executionRequirements(entry, { sourceSupport, diagnostics, activation })`, which is implemented in `effects/execution-requirements` and returns:

- a `mode`: `none`, `activation` or `processing`;
- `needed`, the selected `methods`, the shader rows and the source request;
- a `components` list that gives each component's necessity and reason.

Whether the processor and owned presentation are needed depends on the plan's shader processing, spatial and temporal filters, neural rendering, frame generation, source controls, virtual presentation and explicit diagnostics. Other requirements are narrower: only LS1 and LSFG need Lossless Scaling models, and a selected FSR temporal method needs its own provider. Because the result comes from settings alone, the calculation reads no files, discovers no providers, inspects no models, parses no shaders and does no GPU work.

Dormant activation, which attaches the processor while every effect is off, is decided independently of the processor and presentation requirements. It allows later live changes without turning on any image stage. Once the launch is [bound to its process](#launch-binding), it records the result as `launch.json.executionRequirements`.

### Launch verification

Launch preparation checks the graphics runtime's files before the game uses them, but it limits that work to what the launch needs. It reads the selected runtime's declaration, `runtime.json`, without building the Settings catalog of every installed shader pack and model, and it verifies only the files of the selected components: the shared core, the required shader provider, and the selected temporal provider or neural runtime.

- A verified file is cached by its file identity, together with its declared checksum, size, permissions and architecture. At launch, a changed file is verified again.
- Edit preparation reuses a file verified earlier in the same launcher process against the same entry of the declaration, without checking its identity again. A new runtime directory or declaration entry is verified on first use.
- A file that fails verification is never reused.
- The declaration itself is parsed once for each file identity.

Choosing optional components does not skip a provider's platform or resource validation. In addition, dormant activation verifies the core library and the files it requires. An unavailable or damaged optional bridge is left out before the game starts.

### Provider discovery

Provider discovery is limited in the same way. Preparation of an ordered chain calculates the requirements after the module's native renderer routing and then resolves only the shader IDs that remain selected. It discovers the neural provider only for enabled neural rows and reads Lossless Scaling model metadata only for LS1 or LSFG, so the capabilities of the selected methods leave out unrelated provider discovery. Custom shader rows, however, keep their own compiler and resource validation. The editor's full installed catalog is built separately, as described in [catalog loading](EFFECT_PLANS.md#catalog-loading).

## Shader preparation and reuse

Shader preparation compiles a selected shader into a prepared revision. Launches and parameter updates reuse the prepared revision of an unchanged included, registered or custom selection, provided that the selection, runtime root and process architecture match and the prepared resource still exists. Provider availability, however, is checked again whenever a revision is reused. Whether a selection is unchanged is decided by its identity:

- A custom file's identity includes its filesystem identity, size and modification times, and the identities of its dependencies.
- Registered sources also track the change time, so replacing a file invalidates its prepared revision even when the replacement keeps the size and modification time.
- For an FX program that reads depth, the game's non-default [depth-input definitions](EFFECT_PLANS.md#depth-input) are part of the identity. Changing them prepares those rows again, while rows without depth keep their revisions.
- UI discovery metadata is not part of the compiler identity.

A revision describes a fixed copy of its source. FX validation and resource metadata use the frozen, preprocessed source that is published, so editing the original file during preparation does not change the program that a revision describes. The entry source is frozen before its color policy is read and before preprocessing, while its original filename and include search directories stay available. A custom row also keeps its exact file's coordinate metadata independently of the shared Custom selector. Executable requirements, however, still come from the prepared program.

The offline FX compiler runs in two steps: `--prepare EFFECT.fx PREPARED.fx`, then `PREPARED.fx OUTPUT_DIRECTORY` for full validation. Its output contains GLSL and Metal shaders, `textures.json` with image-source names, `uniforms.json` with parameter metadata and `requirements.json` with the scene-input requirements of each technique. When the graphics component is packaged, this CPU-only contract is checked before a compiler is published.

## Background preparation in the game

Inside the game process, replacement graphs are also prepared in the background, so the running chain keeps working. A native planner prepares each replacement graph on a worker thread, where shader compilation, model construction and resource allocation all happen. Each preparation is keyed by the requested revision, the device and queue, the image geometry and format, the origin, opacity and color, and the scene-input contract. A completed job is put into use only when its request and frame contract still match, and a newer selection or Off discards obsolete work without publishing its result.

Three queues are kept separate: the producer queue, on which the game's renderer or other frame producer submits its work, the queue for detached processing and the final presentation queue. Each row is prepared for the queue that its phase actually runs on, including filters after frame generation or display subframes. When the final queue changes, the affected image resources are replaced, while compatible generator history is kept.

While preparation is pending, a compatible accepted execution or completed image stays available. The planner keeps the resources of unchanged stages and prepares the affected later stages on their own. An older completed frame, however, never acknowledges a changed contract. Because a busy provider and a provider that has failed for good recover differently, repeated submissions never alternate between mismatched old and new output.

To decide what a change affects, each row has two input identities:

- The exact identity covers every upstream control and is the key for cached results and redraws.
- The contract identity covers the image size, format and color, the identities of upstream rows, and their shaders and switches, but not upstream numeric controls.

As a result, when only an upstream control changes and a row's contract identity stays the same, a row with history keeps its prepared node, resources and history. Temporal reconstruction, frame generation, histogram exposure, estimated depth range and in-place shader history then continue, while their exact caches are refreshed. A changed contract, by contrast, recreates the row and restarts its history.

### Paused content

A paused or static producer may submit no new frame after a change has been prepared, so the presenter can notify it when the prepared resources are ready. For this, `preparationNotificationAPI: 1` provides `rsObserveFramePresenterPreparation`, whose versioned observer keeps the callback context through queued notices and unregistering. A readiness notice is posted to the producer queue without rendering synchronously, accepting a revision or creating a new source frame. The paused or static producer then retries its retained image with the same content identity. Such a redraw for changed parameters stays separate from real content progression, so temporal and interpolation history are preserved.

For decoded video, a producer with content timestamps keeps its media time and interval through delayed preparation. Only a new decoded image starts a new interpolation interval, so readiness notices and paused redraws never shorten the current one. During playback, the shared generation phases are mapped to producer deadlines with one interval of lookahead, while file export writes them at their media timestamps.

## Dormant activation

To let Simple and Advanced effects be turned on during play, shared presentation hosts prepare the included processor and an empty effects plan even when every optional effect is off. Hosts without an adapter, however, keep their unfiltered launch path. Until processing is requested, dormant activation leaves the game's drawing alone:

- Dormant live controls install hooks without requesting image processing.
- Quartz capture and Metal framebuffer access follow the active plan or the live controls.
- Dormant drawable requests go straight to the original renderer before device discovery or command-queue setup.
- Remote layer hooks defer image-class probes and layer state until processing is needed.
- Existing owned output keeps its normal retirement path when effects are turned off.
- No model weights are loaded for an empty plan.

Once processing is requested, each kind of setting asks only for the path it needs. CRT-only settings, for example, request the shader path without preparing scaling, generation or model resources. When no separate output is active, size-preserving ReShadeFX can also process a readable native Metal drawable in place, including during native window resizing. Imported shader geometry, reconstruction, frame generation and explicit source scaling, on the other hand, keep their own presentation requirements. Before owned SDR output creates a presentation view, it checks the source image format and readability, and an unsupported conversion keeps the original renderer. CGL and remote surfaces keep their own presentation adapters.

To allow models to be selected during play, live activation reserves the two graphics model storage paths without creating their directories or inspecting models. A neural library path from the included provider layout is also allowed without inspecting or loading the provider. When a neural row is selected, its compatibility, the provider's file list and the model contents are validated before publication, so imported models can be selected during play. The optional source-control, coordinated-presentation and future-model channels are prepared independently. If a channel is unavailable, already prepared graphics stages stay available, and the process architecture and frame-adapter metadata are kept.

Temporal providers are handled in a similar way. The paths of installed temporal providers belong to the launch's fixed selection and can be reserved for later live use without loading their libraries or creating GPU resources. The currently selected algorithm is independent of that reservation: selecting another provider validates its resources and required frame inputs, and the producer's original API does not restrict which algorithms can be selected.

## Launch binding

Live edits have to reach the process that a launch started, so each launch is bound to that process. After optional preparation has produced a child process's environment, the launch core binds the process's actual PID once through `ReShade.bindLaunchProcess`. Launches without the processor neither read nor rewrite an earlier graphics record.

Live preparation and validation then require a matching `launch.json.pid`, and main-process controls supply `runningPids` from the current sessions for this check. When the binding has expired or is absent, an edit saves the preferences for the next launch without compiling or publishing a live plan. After asynchronous preparation, the same launch identity and active session are checked again when the plan, shader selection and controls are published. A stopped or replaced session keeps the saved preferences and leaves the current launch's files alone. Callers that omit `runningPids` keep the standalone API contract.

Some changes always wait for the next launch: models outside the model stores and selected files that the launch was given access to, a different neural provider, temporal methods that need different scene inputs, and scene inputs or render-size control from an engine helper that the launch did not load. To show whether edits can reach the running game, the `graphicsInputs` inspection response includes `graphicsLive` for the Simple controls; this binding check needs no model or provider discovery.

## Live publication

Live edits can change installed models, compatible order, sizes, intensity, history and frame generation. The renderer keeps its accepted output while the replacement is prepared.

### Atomic publication

A live edit goes through a publication, which prepares the new plan and can later commit it or roll it back. A live caller creates the publication with `ReShade.createPublication({isCurrent})` and passes it as `options.publication` during validation and preparation. Until it is committed, the plan being published is called the candidate:

1. Immutable shader revisions are prepared immediately. The accepted plan, selections and control files stay unchanged.
2. A renderer update can use the prepared resources before it calls the synchronous `publication.commit()`.
3. Commit checks the original launch and the accepted file bytes again, publishes complete documents, and writes the effects plan after its selections and controls. Each file replacement is atomic, but the files together are not one native snapshot.

A publication can also be undone. `rollback()` discards uncommitted changes, or restores committed bytes while the same launch and candidate still own every affected file, and `onRollback(callback)` registers an in-process effect of preparation that a rollback reverses together with the files. Separately, `deferred` marks a setting that applies at the next launch.

### Reading the plan in the game

Each native process reads the effects plan on its own serial queue and watches it for changes: a directory watcher sees a replacement by rename, a file watcher sees in-place writes, and a periodic check covers missed events. When a read fails, the last accepted plan is kept and the error is reported. The read is then retried with a backoff from 50 ms to 2 s, and the watcher is set up again when its directory is replaced or could not be opened. Reading the unchanged file again clears an earlier read error. A process whose sandbox refuses the plan path, such as a Chromium helper after its sandbox engages, keeps the plan it read before and cannot follow later edits.

### Reusing prepared rows

A live edit prepares only the rows it changes. Within one launch, an included or pack shader row, or a stage row without a Lossless Scaling model, reuses its earlier prepared result when the row, its capabilities, the runtime root, the host, the architecture, the frame inputs and the graphics settings are all unchanged, wherever the row sits in the chain. The order, however, is still checked for every row. Some rows are prepared again on every edit: custom and filter library shaders, downloadable collections, shader model operations, neural and XeSS rows, Lossless Scaling model rows and forced shader preparation. A new launch prepares every row again.

So that a restarted launcher can reuse these prepared rows for a game that is still running, the main process keeps them in `graphics/live-prepared-rows.json` in the application data directory. This file holds at most 16 plan files of 64 rows each, up to 8 MiB, and is replaced atomically. A stored row is used only for the same launch, the same preparation code (identified by a hash of the preparation modules) and a compiled file that still exists. If the file cannot be read, it counts as empty, and its rows are prepared again.

XeSS work runs on a separate compute host, and its compute requests arrive
as files in a request folder for each launch, which MacLauncher scans when a
filesystem notification arrives. Each request uses the latest registered host
for its backend and operation. When a notification arrives during a queue
scan, one more scan is scheduled right after it, including when launch
preparation and live edits run on separate workers.
The session's periodic liveness check also scans the queue to recover missed
filesystem notifications.

### Models during play

A running game can use only the models that its launch was given access to, so live model choices stay within that access. A live model default resolves to a compatible model that the running process already has access to, when one exists; otherwise, the compatible default is validated inside the model store that the process is allowed to read. Explicit selections of installed models can also change during play, although older sessions without that model-store access keep their original models until the next launch. Neural edits keep the provider library and can select validated models within the allowed stores. Temporal edits in an ordered chain, for their part, keep their actual scene-input connection and the processor resources already accepted while they switch between compatible providers.

Model access acquired for a live candidate belongs to that preparation. If the candidate is rejected or cancelled before publication, its new reservations are released, while access that the running session already holds stays. Once publication starts, the session keeps the candidate's access until the process ends, because restoring files does not show that asynchronous native consumers have finished. Waiting to acquire resources for a candidate can stop without stopping an active writer or a model the game already uses. A lease acquired later without a binding is released by its exact token.

Turning neural reconstruction off cancels pending preparation for that game. Other queued effects keep their settings, and the accepted chain stays active until its replacement is ready. Model downloads started separately stay available in Runtimes.

### Shortcut publications

The bypass shortcut (`src/main/graphics-shortcuts.js`) uses the same main-process edit as the Graphics checkbox to change the saved plan's master switch. It therefore saves the plan and publishes Off, or the saved plan again, as an ordinary live publication.

Every graphics shortcut is held in one registry. Game actions register their global hot keys only while a game runs, whereas an action that starts a session is registered whenever its handler exists. Assignments are validated by `graphics-shortcuts.mjs`, which accepts only Control with two of Option, Shift and Command and rejects the macOS shortcuts of that form.

### Edit order

Edits for each game are serialized in the main process, which saves only successful changes. As a result, graphics edits keep their order for each game, and independent partial edits also keep their order. Leaving an Advanced preview without editing keeps the Simple settings and sends no runtime update. Stop, and resetting an Advanced chain, both cancel pending shared graphics preparation; later edits then wait for the cleanup and for the accepted settings to be restored. A cancelled preparation can never publish a later revision.

Queued edits from earlier shader controls must not replace the parameters of a newly selected shader. For this reason, a shader parameter save can include an `expectedSelection` with its patch, and the serialized setter checks the selected preset, the custom source and the chain order before preparation.

## Partial live edits

A live edit can be published even while some of its rows cannot run yet. To find those rows, `launch-binding.nodeUnavailableReason` checks each row against the current process's graphics and model bindings. `effects/live-plan` then keeps the previous, unchanged native row in place of an unavailable replacement, or disables a row that has newly become unavailable, and the compatible rows join the same atomic publication. Both the requested and the effective order are checked row by row, and a retained model row is not prepared again from the future model selection. An edit with no independently usable enabled stage, however, is deferred as a whole, and compiler failures, cancellation and stale launches still reject the candidate publication.

### Model downloads for pending rows

A live edit can select a model operation for which no compatible model is installed. That row then stays pending while the other rows publish, and preparation names the recommended download for the operation. The graphics status asks for consent once per download, for every game waiting on it, and a declined, closed or replaced dialog downloads nothing. With consent, the download runs through the model manager's own setup action, shares its progress and cancellation with Runtimes, and joins a download of the same source that is already running.

After installation, the current desired plan is prepared again. The row then activates in the running game when its launch binding accepts newly installed models (`launch-binding.acceptsNeuralModels`); otherwise, it reports that it applies at the next launch. After a declined, cancelled or failed download, the download is not requested again until that row's selection changes.

### Keeping accepted resources

Even when only part of an edit runs, the saved plan always stays the complete requested plan. What runs is recorded separately: a successful live publication stores `graphicsLivePreparation` in its launch record, with the prepared revision, the requested and applied rows and the pending reasons.

A partial live edit can keep earlier resources only after the game has explicitly acknowledged those resources for the same launch. In addition, a history of up to four immutable native documents keeps the accepted graph available when a newer published candidate was rejected. A missing, stale or conflicting acknowledgment defers the partial edit. Ordinary supported live edits, by contrast, do not depend on status being available.

The acknowledgment is read during the edit by `runtime-status.acquireAccepted`, even when no status panel is open. It takes a short scoped status [lease](STATUS_AND_DELIVERY.md#leases-and-readers) and waits asynchronously for up to 2.5 seconds, or 5 seconds for a selected neural stage; cancellation and launch changes interrupt the wait. Afterwards, the previous lease is restored unless another consumer renewed it. A timeout keeps the current graph and leaves the request pending, and the game does not need to restart.

An untouched dormant activation, in contrast, can prepare independent new stages without keeping old resources. This requires the exact current launch, its original empty document, the original Off controls, and no earlier graphics preparation or document history. A new generator that is unavailable can then stay pending while a compatible shader is prepared. Resources that were active before, however, still require explicit native acceptance. Supported edits, Off and requests without an independently usable stage do not take this lease. All of this describes preparation; native completion and presentation are observed separately.

## Failures and fallbacks

Because parts of a plan can fail, preparation returns two plans: the requested editor `plan` and a separate `appliedPlan`. In the applied plan, the source-resolution request holds the size and optional source method emitted at launch. Live preparation reports the allocation that already exists, while unavailable or changed source requests stay in the editor plan. When the scaling or reconstruction stages that an automatic source reduction serves are unavailable, preparation removes that reduction and its source request. Manual Advanced rows and requests, however, keep their saved sizes, and independent rows stay usable.

A row is bypassed with its reason, while independent supported stages and the saved request stay, when it:

- breaks the order, which is checked row by row in every preparation;
- is unavailable or incompatible at launch or in a running game;
- has a shader, resources or a compiler that fail.

The bypassed row's graphics status names the reason, and later edits prepare the row again. A source request that the bypassed row owns is removed with it. When an edit for a stopped game is checked, an unavailable row is reported instead. A live edit is rejected as a whole only when its plan cannot be read or its publication fails; in that case, the running game keeps its last accepted chain. Export preparation, by contrast, validates the readable rows strictly.

Failures also stay independent of one another: a failed frame generator does not disable an independent shader, and a failed shader does not disable a compatible scaler. In ordered native Metal and OpenGL chains, missing scene or depth inputs bypass the rows that depend on them, while ordinary color stages continue. Scene processing uses the renderer's matching inputs, and no fallback fabricates depth or motion.

The same per-row launch fallback is available to callers that request it, through the independent `Effects.prepare({effects}, {fallback: true})` API. Successful standalone Simple methods keep their original runtime path. When native graphics preparation fails, a supported ordered processor can prepare the compatible rows instead. If shared preparation cannot produce any compatible chain, the game keeps its original rendering and the failure is logged. Cancellation, however, is passed on and still stops the launch.

### Launch records and warnings

Each launch records the outcome of preparation. `preparationStatus` describes the requested, applied and skipped shared stages, and the requested and applied source sizing, and `launch.json` stores it as `graphicsPreparation`. Its `graphicsWarnings` field holds structured `{id, kind, method, reason}` entries for skipped rows and for saved parts that could not be read, with a readable feature name in each reason. The launcher shows these warnings for the matching game process. When preparation fails before a graphics publication exists, the launch result instead carries a separate warning through backend IPC to the inspector. Warnings never change the saved settings or turn a successful game launch into a failure. Preparation status covers resource preparation, not completed neural inference or display presentation.

### Failures while running

Failures during play are contained in the same way. When a provider fails on a frame for a reason other than being busy, that row's input is fitted across its complete output, so partial writes from the failed stage are overwritten, and independent later stages continue. A busy provider, by contrast, keeps the previous complete image rather than mixing it with a fresh source frame. A neural inference failure keeps the current stage input and the complete-image presentation path. Live edits also keep the accepted output when a replacement cannot be prepared.

Temporal upscaling has one frame-local fallback. When the selected temporal method is FSR 2, FSR 3, FSR 4, XeSS, Arm ASR, Snapdragon GSR 2 or MetalFX Temporal Denoised and it does not encode a frame, that frame is encoded with MetalFX Temporal, the default method. The frame's result names MetalFX as the method that encoded it, and the first fallback of each method in a game process is logged and reported in the graphics status with the requested and active methods. The selected method stays selected and is tried again on the next frame. When MetalFX also fails, the frame fails as described above. Observers of an original output that the renderer keeps never fall back, so the renderer's completed image is not replaced.

## Native plan document

The game reads the native plan from `RESHADE_EFFECT_PLAN`, a private JSON file that holds a revision, a mode and the ordered `nodes`. An Advanced document with no enabled nodes and no output processing is a pass-through chain, which native code acknowledges with its revision like any other publication. **Clear effects** and a launch without processing publish the empty Advanced document (`Effects.emptyDocument`).

Updates to this document are published atomically. One native reader per game process parses each update once, when the file changes, and every consumer reads the resulting immutable snapshot:

- A document that cannot be read, has an invalid top-level structure or uses a newer schema is rejected as a whole. The last accepted plan keeps running, and the error is reported.
- In a readable document, each row is validated on its own. An invalid or unsupported row stays in place as a disabled row, its reason is logged and reported as a bypassed stage, and the valid rows run.
- An invalid output block falls back to the default output settings.

Four output options need support from the running graphics package and frame source: `output.hud`, `output.frameRateCap`, `output.displaySync` and `output.drawableCount`. An older graphics package rejects an output block with unknown fields, so the launcher publishes these options only when both declare them (`effects/output-options.js`). An undeclared option stays in the saved plan but is left out of the native document, and the preparation lists it among its pending output reasons. Once declared, the overlay, the cap and the presentation options change live with each publication.

Shader resources are initialized before they replace a working execution chain. Prepared FX bundles resolve frame dimensions for each native stage, and again when that stage's input size changes.

# Runtime status and processor delivery

[Pipeline overview](PIPELINE.md) · [Graphics guide](README.md)

While a game runs, its graphics processor reports what it is doing through a runtime status page. The main process combines those reports with its own record of the plans it has published to the game into one graphics status record per game, which the editor displays. Status only observes processing; missing or expired status never prevents rendering or turns processing on.

This page describes the runtime status API, the graphics status record, how each launch keeps one fixed version of the graphics processor package (its payload), and how that package is built and delivered. [Preparation and live updates](LIVE_UPDATES.md) describes the preparation and publication that the status reports on.

[Runtime status API](#runtime-status-api) · [Graphics status](#graphics-status) · [Immutable launch selection](#immutable-launch-selection) · [Sources, build targets and delivery](#sources-build-targets-and-delivery)

## Runtime status API

A graphics package that supports runtime status declares `features.graphics.runtimeStatusAPI = 1`, which turns on optional observations of shared processing. For such a package, launch preparation records `launch.runtimeStatus` and passes `RESHADE_RUNTIME_STATUS_FILE`, `RESHADE_RUNTIME_STATUS_LAUNCH_ID` and `RESHADE_RUNTIME_STATUS_TOKEN` to the game. When graphics are off, this metadata has no effect.

### Leases and readers

Observations are recorded only while a reader holds a lease, a time-limited claim on the status page that the reader renews while it keeps reading. An enabled processor also takes a six-second observation lease in advance, before launch and before an explicit live publication, so a static image can report its actual processing before an inspector opens. Taking this lease creates no image or GPU work.

- `runtime-status.read(entry, {userDataDir, runningPids})` serves inspector requests. It requires the currently bound launch, creates the page for an active inspector request and renews the same lease.
- A live publication reads native acceptance through the same lease. `runtime-status.accepted` reads a held lease, and `runtime-status.acquireAccepted` requests one for a limited time. Neither turns on recording or image processing.
- `launcher:getGameGraphicsStatus` reads the state without building the effects catalog. The inspector requests it only while **Runtime status** is expanded, the inspector is visible and the game has graphics enabled. Filters of the original renderer report independently of the shared processor.

Expired observations keep their original timestamps and stay historical. A launch can also be unable to attach the processor at all, when its launch binding records a confirmed restriction, such as one found by the [code-signature check](INPUTS_AND_ADAPTERS.md#code-signature-check). In that case, active runtime status returns `unavailable` with that reason at once, and live edits report the same restriction before they prepare providers or models. Off keeps its normal status.

When neural processing is turned on live in Simple, the same reader is used to wait, for up to 120 seconds, for the first matching completed neural frame. Collapsing the details does not end this wait. Instead, the automatic queries end on completion, a reported fallback, Off, Stop or expiry, and completion must match the current settings and neural stage.

### Status page

The status page is a file with the fixed `MLFXSTS1` layout, which the game process maps into memory. Each part of the rendering that reports status, such as a window layer, a presenter or a temporal encoder, writes to a context of its own. The page has eight context slots, and each slot holds up to 32 stage records. Because every record uses a sequence counter, readers can discard incomplete updates. When all eight slots hold rows of the same process, a new context reuses the oldest row that has not been written for more than six seconds.

Native control polling maps the authenticated page only while processing is actually requested, and the mapping keeps no file descriptor. To record an observation, the processor copies fields of limited size into the mapped memory, without filesystem operations, allocation, serialization, waiting or a worker thread.

A runtime that submits its own textures through the frame API has no AppKit control loop to do this polling. For such a runtime, graph preparation maps the status page for an existing lease on its preparation worker, before the runtime's first image. The runtime can also request discovery of the page through the existing utility queue, at most once per second while processing is enabled; its render callback only requests that work and never opens or maps files. Once the page is mapped, no further discovery is needed, and Off invalidates pending discovery requests.

### What contexts record

- For a valid plan that selects no image processing, such as Off, a master bypass or every row disabled, a context still records the plan's revision as accepted, in an already mapped page and while a status reader holds the lease. Metal window, frame API, OpenGL and presenter hosts all record this acceptance, and rows that the plan reader rejected appear as bypassed stages with their reasons.
- A stage's active method names the method that ran, such as a spatial provider's fallback method, rather than the one requested.
- A temporal encoder records its own context. After each encoded scene, it records the plan revision it applied. A presenter that consumes the encoder's output records that frame's stages under its own context, and output that nothing consumes keeps them under the encoder. An encoder that stops producing ordered scene output, or whose owner is released, records Stopped, so acceptance does not wait for it.
- Metadata about incoming frames, such as a source layer's present and frame-owner counts, keeps a context current only while that context holds no frame phase and no accepted revision. A source layer whose frames are reported under its presentation's own context therefore stops counting toward its earlier revision.

A browser host that uses [completed-window capture](INPUTS_AND_ADAPTERS.md#completed-window-capture) records from its control tick. While graphics processing is off, it records the pass-through revision for the selected window. While processing is on, it records Failed when its capture attempt for the window has failed with no recovery attempt pending. That record carries the current plan revision and the capture failure as the reason, and it is written at most once per second for an unchanged revision. A new capture attempt, another selected window or a window that is no longer visible ends that context, and once processing is off, the pass-through record replaces it.

### Replacement graphs

When the plan changes during play, the processor prepares a replacement graph while the accepted graph keeps running. The replacement reports separately from the running graph:

- While it is still preparing, it records Preparing (phase 8) with its own candidate revision and reason. This does not count as acceptance of the running graph or toward resource acceptance. If preparation takes longer, its readiness checks slow down, and it stays eligible for a late completion.
- When its preparation fails, it records Failed with its own plan revision and reason under a context of its own, once per second while it stays rejected. The previously accepted graph keeps running and recording its earlier revision. A later accepted replacement, or the end of its owner, retires that context.
- When it waits for a busy provider resource, such as a full scratch budget, the accepted graph keeps running and the replacement retries every 250 ms at first. Prolonged pressure slows the retries and leaves the affected row pending while independent rows can run. Elapsed time alone never rejects the graph or permanently bypasses the row.

Device image memory may not be able to hold both the accepted graph and its replacement. In that case, the accepted graph is released before the replacement is built: rows that the replacement reuses are kept, and the others are freed before the replacement allocates. Meanwhile, the replacement records Preparing, and callers present their last completed output. After one second, rows that still do not fit stay pending in an adopted partial graph and are retried until memory is available. A resource retry of the accepted revision, however, does not release it. An allocation that can never fit, or an actual provider error, keeps its failure reason.

A replacement shader, spatial or neural row can also fail with an actual error. When the accepted graph ran that row from the same input, the replacement keeps the row's accepted version: its stage records the active method `retained` with the error, and later rows are prepared against the output of the retained version. At launch, or when no compatible accepted version exists, the row is bypassed with its reason instead.

### Events and observations

Each observation is a `RuntimeStatusEvent`, which distinguishes preparation, encoding, GPU completion, presentation, bypass and failure. Presenter integrations emit presentation only from a positive presentation callback. A context record includes the rendering process's PID and start time, the prepared plan revision and the controls digest (a hash of the live control values in effect), the actual input and output sizes, and the methods and reasons of each stage. Its frame counts cover only observations made while the reader's lease is active, so they measure neither the source frame rate nor physical scanout.

The optional `frameSource` observation identifies the actual frame source: a Metal drawable, an OpenGL framebuffer, a layer surface, a software bitmap, a browser window stream, an explicit texture or decoded video. Its input flags describe the scene guides, such as depth and motion, supplied with the observed frame. Runtime names and declared attachment hosts never stand in for this observation. These fields reuse the existing leased status page and create no capture stream or extra polling.

For [Adaptive quality](README.md#adaptive-quality), the optional `adaptiveQuality` observation identifies the target row, the policy state, the applied processing scale, the smoothed duration of completed GPU jobs and the measured scope. The scope is one of source plus processing, an owned image-processing job, final processing, an offline frame or affected external processing. The timing is gathered as follows:

- libplacebo reports timestamp intervals from its actual rendering queue.
- The neural provider reports completed MLX graph intervals and conversion and publication intervals for image, restoration, estimated-depth and paired generation jobs. Direct execution and the ARM64 service use the same optional timing contract.
- The affected image rows and pair or phase jobs for one real input, including image work between generators, form one sample. Exact cached copies neither reuse the original inference cost nor advance the adaptation.
- A caller-command duration that includes a wait on another queue is not added to external intervals. The policy stays pending while any affected external operation lacks matching GPU timing, and missing timing is never shown as zero milliseconds.
- The Vision and VideoToolbox optical flow that temporal NR and image SR use has no complete GPU timing record; scene SR uses a separate scene interface. Their processing stays available while the affected adaptive policies stay pending.

These fields use the existing context lease and match its accepted plan identity.

Each stage record also holds the row's measured GPU time. Rows are measured while a status reader holds the lease or the performance overlay is on, but stage records are written only under the lease. The measurement reuses the intervals that Adaptive quality already uses and starts no other timer.

How a row is timed depends on its provider. A row whose provider reports its own GPU interval, such as a neural row or an external-queue generator, records that interval with the `row` scope. Every other row records the duration of the completed command buffer that contains it, with the `section` scope and a section number: section 1 is the buffer that processes each source image, including generation, and section 2 is the buffer of each displayed image. Rows with the same section therefore share one value, and a buffer that also carries the game's own rendering includes that work. Each value is a running mean. Details lists it beside the row and names the rows that share a section, and the performance overlay uses the same values. A row on an external queue that reports no interval records nothing, and missing timing is never shown as zero milliseconds.

Readers match each observation to the settings it describes. Stopped or older observations stay historical, and a prepared revision that does not match identifies previous settings. For an Advanced execution, the plan revision identifies its ordered settings, while Simple observations are identified by both the prepared revision and the controls digest. Missing identities are labeled unconfirmed. To report each row, the current saved requests and the row's pending reasons are combined with the latest preparation metadata, without provider or model discovery. A pending row reports retained resources only when the exact matching request has acknowledged retention metadata.

### Performance overlay counters

The [performance overlay](FRAME_API.md#performance-overlay) takes its values from counters that the shared presenter keeps for its status. Unlike a status reader, it needs no status lease, and it samples the counters at most four times per second. Rates come from counter differences between two samples, and a counter that restarts contributes no rate. When a source cannot measure a value, the overlay shows a dash.

| Counter | Source |
| --- | --- |
| Capture, output and generated rate | Accepted source images, displayed images and displayed generated images per second |
| Target rate | With generation: the adaptive pacing target, or the source rate times the images displayed for each source image. Without generation: the selected source cap, or the measured capture rate. The display refresh limits each target. |
| Display refresh and capture interval | The output display's nominal refresh period, updated by its running display link when available, and the source period that paces interpolation. Display timing is also read without a generation row. |
| GPU time and budget | The GPU duration of the command buffer that carried the final presentation, against the adaptive quality budget or one refresh interval |
| Row GPU time | Detailed only: each effect row's running mean from the stage costs above, ordered by section, with rows that share a section's command buffer marked with that section |
| Latency | Capture: source timestamp to presenter encoding. Presentation: encoding to the display callback. End to end: source timestamp to display. Sources without host-time timestamps report none. |
| Pacing | 100 minus the relative deviation of the last displayed intervals, from 0 to 100 |
| Memory | The process footprint and the Metal device's allocated size |
| Captured, Presented, Generated, Passthrough, Dropped | Accepted source images; displayed images, counted separately; displayed generated images; displayed real images; images that were not displayed |
| Provider | Detailed only: the frame-generation provider that runs and its reason, or `passthrough` with the display refresh reason while the display limit leaves no refresh for a generated image |

Generated plus Passthrough always equals Presented. When the separately counted totals disagree, the overlay shows a counter mismatch line.

## Graphics status

The editor's status labels all come from one graphics status record per game, which the main process keeps (`src/main/graphics-status.js`). The record holds the desired plan revision, the last publication, the latest native acceptance, the reason for any difference between them, and the state of each row. Its phase is one of these:

| Phase | Meaning |
| --- | --- |
| `saved` | The plan is saved and the game is not running. A reason records the last failure or a change that waits for the next launch, and a new edit or launch clears the previous failure. A row that cannot be prepared does not reject a stopped game's plan; the launch bypasses the row and reports it. |
| `deferred` | The running game keeps its current graphics, and the plan applies at the next launch. A game started without live graphics editing reports this at once. |
| `preparing` | The running game's plan is being prepared, retried or published, or native code reports fresh preparation of the exact published revision. Work completed earlier does not confirm the candidate. |
| `acquiring` | A model download for a pending row is running. |
| `published` | The plan was committed to the running game and waits for native acceptance. |
| `applied`, `partial` | Native code accepted the published plan. `partial` lists the reasons of rows that are pending or not running. |
| `rejected` | Preparation or publication failed. `retained` names a previously accepted graph that stays active. |
| `unconfirmed` | The game did not report the publication within the fast confirmation window. The latest native frame reason is included when available, and a later acceptance still moves the record to `applied`. |
| `invalid` | The saved plan cannot be read. Editing is blocked until **Clear effects**, and launches bypass shared graphics. |

### Row states

Each row in the record is `active`, `off`, `pending`, `retained`, `failed` or `bypassed`.

- A `bypassed` row was left out of the running plan with its reason, such as a saved row that could not be read or a row that breaks the order. The other rows run, and the phase is `partial`.
- A row that the accepting contexts report as bypassed or failed with a reason, such as missing renderer depth, motion or jitter, an unsupported capability, busy image capacity or a display refresh rate that leaves no refresh for a generated image, also becomes `bypassed` with that reason once this has lasted one second without the row completing a frame. A row they report as still preparing with a reason, such as a neural provider warming up, becomes `pending` with that reason in the same way. A shorter bypass, such as busy capacity during a change, is not reported.
- A live edit that cannot be prepared for a row whose earlier version the running game accepted republishes that accepted version instead. The row reports `retained` with the edit's reason. The saved plan keeps the edited values, and the next publication prepares them again.

For a row that is not running, acknowledging a revision waits out that one second. The acknowledgment reads the rows from the contexts that accepted the revision, so a context that still shows the previous revision does not hold it back. When the confirmation window ends during that second, or acceptance arrives after it, the revision applies at once with the rows known not to run marked `bypassed`, and the outcome is updated when the second ends. Later status reads update a row the same way when it stops or resumes running under the accepted revision. A row that no current context reports, however, keeps its state. If a publication fails, the record's `published` entry is restored to the publication that was running before it.

### Off and empty plans

Off and an empty plan are publications like any other: they are applied when native code acknowledges their document revision. While the status lease is held, native code acknowledges a graph without processing as pass-through, and every live publication takes that lease before it is committed. The game's selected window also acknowledges the revision every 250 ms without drawing, so a route that stops at Off, such as a browser stream, or a game that is idle still confirms it.

A game that has not processed since launch, such as one launched with graphics off, opens the leased status page from the same tick, at most once per second, without recording frames. When processing resumes, that window context ends. An ended context records Stopped whether or not processing or a lease is active, so it never counts as drawing.

### Stalled and hidden windows

A Metal game can stall while it waits for a drawable. During image processing, a drawable request that returns no drawable, or that waits at least 500 ms, marks its layer as stalled. Unless a later request completes within 500 ms, a separate context for that layer then records the current plan revision as Prepared every second, without accepted resources. This context never fails and does not count toward acceptance. Its reason names the observed wait and says that the change applies if the game draws again, so a publication made during the stall becomes `unconfirmed` with that reason, and a later acceptance still applies it. The first stall of each layer is logged.

Some engines, such as Godot 4, stop presenting while macOS reports their window hidden (fully covered, minimized or on another Space), and they can still render frames that are never presented. For this reason, the window of each such layer is watched through its AppKit occlusion notification, and diagnostics record its initial state and each change as a `window-hidden` or `window-visible` state of the selected window. The layer context records Hidden (phase 9) every second, with the reason that the game window is hidden and the change applies when it is visible again, while all of these hold:

- image processing is active;
- every watched game window is hidden;
- no virtual output window is in use;
- no game drawable request has completed within 500 ms for a second.

No revision is accepted while a Hidden record is current, so a publication made meanwhile becomes `unconfirmed` with that reason, even when another context keeps encoding frames. The next game drawable request that completes within 500 ms records Prepared without a reason on that context, which ends the Hidden record at once. Without such a request, the record expires six seconds after the window becomes visible again.

### Acceptance

Only the contexts that are drawing count toward acceptance. While a request waits for a revision, a context that records nothing for 500 ms after the request, such as one that stopped processing after an Off, no longer holds back the contexts that report the new revision. The same applies once its last record trails another context's by 500 ms, such as a final pass-through acknowledgment just after an On. In either case, the context takes part again with its next frame. A context that has never accepted a revision and reports no frame phase does not count toward acceptance at all. Acceptance of another revision, before or during the wait, does not end it.

Each revision settles only once. Publishing the same revision again for the same desired plan keeps its `applied`, `partial`, `rejected` or `unconfirmed` outcome, and no later window or timer moves it back; only a late acceptance still moves `unconfirmed` to `applied`. A repeated acknowledgment that changes nothing sends no status event.

### Confirmation windows

Each outstanding publication has a confirmation window, the time in which native acceptance is expected. The fast window is 5 seconds, or 30 seconds when the publication adds a neural or model row or changes a virtual source. A fresh native Preparing report for the matching launch and revision extends the window to 120 seconds from publication, although repeated reports do not restart it. Afterward, known preparation stays Preparing, and the existing observer checks the metadata every five seconds; a valid late acceptance still applies.

A missing acknowledgment uses the diagnostic `unconfirmed` state. Neither an expired observation nor this label invalidates the graph. Native Failed, by contrast, reports the actual error, while the previously accepted graph stays available. Absent, stale or unrelated progress cannot claim preparation or acceptance.

A newer desired plan replaces the record's sequence, and events from earlier sequences are ignored.

### Sessions and retries

A running session binds the record to its launch and process. A process can be registered before its launch records the process identity, so an unbound session is read again for a few seconds and on each status read. Once the session is bound, a launch that prepared the current saved plan counts as that plan's publication. Rows the launch bypassed are `bypassed` with their reasons, and native acceptance of the launch document moves the record to `applied` or `partial`. A launch plan that needs no processing, such as Off, is instead `applied` with its rows `off` as soon as the launch binds, without native acceptance. When the session ends, a publication in progress becomes `saved` with a next-launch reason. No timer runs for a game whose status has settled.

A live publication needs native acceptance of the running graph to keep its unchanged rows. When that acceptance is not available within its wait, because the game has not drawn a frame yet or another reader holds the status lease, the publication is tried again after 1, 2 and 4 seconds. A newer desired plan ends this schedule, and after the last attempt, the plan is `deferred` with the reason. This retry and the session binding retry both use one shared retry schedule with a fixed number of attempts (`src/modules/shared/bounded-retry.js`).

### Status channel

The renderer has one graphics status channel. `launcher:getGraphicsStatus(gamePath)` returns the current record, and `launcher:graphicsStatus` delivers each change to launcher windows as `{gamePath, status, plan?, activeLaunch?}`, where `plan` accompanies a new desired plan and `activeLaunch` identifies the running launch bound to the game. Bursts of changes are coalesced for each game, but final phases are sent immediately. The preload exposes `getGraphicsStatus(gamePath)` and `onGraphicsStatus(callback)`, which returns an unsubscribe function.

Native acceptance is read through a single function, `acceptance` in `effects/runtime.js`, which both the live projection and the status record use.

## Immutable launch selection

A running launch keeps the processor payload, manifest and helpers it started with until it ends. Publishing another included version therefore changes the selection only for later launches, while live discovery, compilation and resource preparation keep using the running launch's payload. This binding is stored in the launcher's own storage, separate from the game's writable controls, and a file path supplied by the game cannot select a compiler or compute-host executable.

## Sources, build targets and delivery

Unlike game runtimes, the graphics processors, shader helpers and the included shader collection are part of the app and update with MacLauncher, so no runtime needs a separate graphics download. Lossless Scaling models, which come from a licensed copy, are imported in a separate action.

Each Git source used by the build is fixed to an exact commit of its public repository, either as a submodule or as a declared build input of a provider. MacLauncher's own build recipes and overlays (its changes to upstream code) are kept outside the upstream checkouts. [Building the graphics component](../runtimes/UPSTREAMS.md#building-the-graphics-component) describes the build command, its inputs and the required tools.

The graphics component is built and published by [MacLauncher Builds](https://github.com/procrastinine/maclauncher-builds), MacLauncher's companion build repository. Its graphics recipe assembles the production CMake tree from MacLauncher's own base files, the registered overlays and the processor sources at the commits that MacLauncher Builds records. CMake then builds these production targets: `reshade-macos`, `fx-compile`, `shaderc-offline`, `maclauncher-graphics-video` and the metadata-only `maclauncher-graphics-hardware` query.

The core binaries are reproducible. Compilation maps source and build paths to fixed prefixes, and links use small arm64 Objective-C selector stubs whose order is stable between links, so the same source commits, SDK and linker produce identical core binaries in any build directory. The complete MetalFX API is compiled with the macOS 27 SDK, and availability checks at run time keep the core's minimum macOS version separate from the macOS and GPU requirements of each operation.

The Slang provider uses librashader 0.12.1 with its unchanged baseline C ABI, plus an added Metal API for named inputs and uniform snapshots. Binary inputs keep their exact artifact hashes, architectures and macOS requirements. Some optional providers have a newer platform minimum, but such a provider does not raise the requirements of the baseline FX or Slang library. Instead, its packaged native files declare `optionalLoad: {architectures, minimumMacOS}`, and the launcher loads them only when the game process meets those requirements.

A package records the SDK it was compiled with in `runtime.json` as `build.sdkVersion`, and that value does not change the package's `minimumMacOS`. Because individual operations keep their own macOS and GPU requirements, one package can contain features for several macOS versions: MetalFX spatial and temporal scaling require macOS 13, while denoised scaling and interpolation require macOS 26 and GPU support for the operation.

MetalFX's extended motion-vector conventions and texture subregions have requirements of their own: `features.graphics.metalFX27InputsAPI: 1` and the minimum macOS version in `features.graphics.requirements.metalFX27Inputs.minimumMacOS`, which is at least `27.0`. The app's graphics capabilities report whether these inputs can be used as `metalFX27Inputs`. This flag affects only the extended inputs, and other MetalFX operations keep their own requirements. Before it uses the extended inputs, the native frame path also checks the compiled API and the running macOS version.

Packaging also checks that a library declaring the [static-content](PROVIDERS.md#static-content) flag contains that step's blend-back pass.

Packaging stores identical provider files once, but only within the paths that a provider declares. In its `provider.json`, a provider lists as `resolvedPaths` the path prefixes that its native code opens through the shared payload resolver. The Arm ASR, AMD FSR 2 and 3, AMD frame interpolation and FSR 4 providers list their shader permutation and native model directories there. Notices, executables and files outside the declared prefixes always keep their own paths.

Within one provider directory, the first of several identical files in sorted path order keeps the content, and an index, `payload-aliases.json` in that directory, maps every later path to it. Because the index is an ordinary file, a package still contains only regular files and directories, and the manifest lists the stored files and the indexes. The providers and the app resolve paths with one rule: a path that exists is the stored file, and an absent path is looked up in the nearest index above it. An alias never points outside its provider directory, so a sandboxed game process that may read that directory can read every file the provider opens.

Packaging verifies each file's hash, actual CPU slices, signature and minimum OS load command, including those of optional files. The required binaries must still cover the package's baseline architectures and macOS version. The upstream inventory and the component notices record the source and license of each component.

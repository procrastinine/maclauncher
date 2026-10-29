# Runtime status and processor delivery

[Pipeline overview](../GRAPHICS_PIPELINE.md) · [Graphics guide](../GRAPHICS.md)

Runtime status is a product API that describes current processing. Processor manifests, source inputs and resource binding define installation and lifetime independently of those observations.

[Runtime status API](#runtime-status-api) · [Graphics status](#graphics-status) · [Immutable launch selection](#immutable-launch-selection) · [Sources, build targets and delivery](#sources-build-targets-and-delivery)

## Runtime status API

`features.graphics.runtimeStatusAPI = 1` enables optional shared-processing
observations. Launch preparation records `launch.runtimeStatus` and passes
`RESHADE_RUNTIME_STATUS_FILE`, `RESHADE_RUNTIME_STATUS_LAUNCH_ID` and
`RESHADE_RUNTIME_STATUS_TOKEN`. Off preparation remains inert metadata. An
enabled processor primes a six-second observation lease before launch and
before an explicit live publication, so a static image can report its actual
processing before an inspector opens. This creates no image or GPU work.
`runtime-status.read(entry, {userDataDir, runningPids})` requires the currently
bound launch, creates the page for an active inspector request, and renews
the same lease. Expired observations retain their original timestamps and
remain historical. A live publication reads native acceptance through the
same lease: `runtime-status.accepted` reads a held lease and
`runtime-status.acquireAccepted` requests a bounded one. Neither enables
recording or image processing.
If the launch binding records a confirmed native attachment restriction, active
runtime status returns `unavailable` with that reason immediately. Live edits
report the same restriction before preparing providers or models. Off retains
its normal status.
Simple live neural activation uses the same reader while waiting for its first
matching completed neural frame, for up to 120 seconds. Collapsing the details
does not end this bounded activation wait. Completion, a reported current
fallback, Off, Stop or expiry ends the automatic queries. Completion matches
the current settings and neural stage.

The fixed `MLFXSTS1` page contains eight context slots, each with up to 32 stage
records. Each record uses a sequence counter; readers discard incomplete
updates. Native control polling maps an authenticated page only during actual
processing demand. Observations copy bounded fields into mapped memory without
filesystem operations, allocation, serialization, waiting or a worker thread.
A valid plan that selects no image processing, such as Off, a master bypass or
every row disabled, records its revision as accepted in an already mapped page
while a status reader holds the lease. Metal window, frame API, OpenGL and
presenter hosts record this acceptance, and rows that the plan reader rejected
appear as bypassed stages with their reasons.
A stage's active method names the method that ran, such as a spatial
provider's fallback method, rather than the requested one.
A temporal encoder records its own context. After each encoded scene it
records the plan revision it applied. A presenter that consumes the encoder's
output records that frame's stages under its own context; output that nothing
consumes keeps them under the encoder. An encoder that stops producing ordered
scene output, or whose owner is released, records Stopped, so acceptance does
not wait for it.
Admission metadata, such as a source layer's present and frame-owner counts,
keeps a context current only while that context holds no frame phase and no
accepted revision. A source layer whose frames its presentation reports under
the presentation's own context therefore stops voting with its earlier
revision. While graphics processing is off, a completed-window browser host
records the pass-through revision for the selected window from its control
tick. While processing is on and that host's capture attempt for the window
has failed, with no recovery attempt pending, the same tick records Failed with
the current plan revision and the capture failure as its reason, at most once
per second for an unchanged revision. A new capture attempt, another selected
window or a window that is no longer visible retires that context; with
processing off, the pass-through record replaces it. When all eight slots hold rows of the same process, a new context reuses
the oldest row that has not been written for more than six seconds.
A replacement graph that is still preparing records Preparing (phase 8) with
its own candidate revision and reason. This is separate from acceptance of the
running graph and does not contribute a resource-acceptance vote. Preparation
that takes longer slows its readiness checks and remains eligible for a late
completion. A replacement graph that fails preparation records Failed with its own plan
revision and reason under a context of its own, while the previously accepted
graph keeps running and recording its earlier revision. A later accepted
replacement, or the end of its owner, retires that context. A replacement that
waits for a busy provider resource, such as a full scratch budget, keeps the
accepted graph and initially retries every 250 ms. Prolonged pressure slows
retries and leaves the affected row pending while independent rows can run.
Elapsed time alone does not reject the graph or permanently bypass that row.
When device image memory cannot hold both the accepted graph and its
replacement, the accepted graph is released before the replacement is built.
Rows that the replacement reuses are kept; the others are freed before the
replacement allocates. The replacement records Preparing while callers present
their last completed output. After one second, rows that still do not fit stay
pending in an adopted partial graph and are retried until memory is available.
A resource retry of the accepted revision does not release it.
A structurally impossible allocation or genuine provider error retains its
failure reason. A Failed record repeats once per
second while the replacement stays rejected.
When a replacement shader, spatial or neural row fails with a genuine error and
the accepted graph ran that row from the same input, the replacement keeps the
row's accepted version.
Its stage records the active method `retained` with the error, and later rows
are prepared against the retained version's output. At launch, or without a
compatible accepted version, the row is bypassed with its reason.
Graph preparation also maps an existing lease on its preparation worker before
the first image from an explicit producer, which needs no AppKit control loop.
Explicit producers can request discovery through the existing utility queue,
coalesced to at most once per second while processing is enabled. The render
callback only requests the work; it does not open or map files. A mapped page
needs no further discovery task. Off invalidates pending discovery requests.
The mapping keeps no file descriptor. Missing, expired or unavailable status
never prevents rendering or activates processing.

`RuntimeStatusEvent` separates preparation, encoding, GPU completion,
presentation, bypass and failure. Presenter integrations emit presentation only
from a positive presentation callback. Context records include the producer PID
and process start identity, prepared plan revision and controls digest, actual
input/output extents, and stage methods/reasons. Frame counts belong to observations
made while the consumer lease is active; they are neither source FPS nor physical
scanout measurements.
The optional `frameSource` observation identifies the actual producer as a Metal
drawable, OpenGL framebuffer, layer surface, software bitmap, browser window
stream, explicit texture or decoded video. Its input flags describe guides
supplied with that observed frame. Runtime names and declared attachment hosts
do not substitute for this observation. The fields reuse the existing leased
status page and create no capture stream or additional polling.
The optional `adaptiveQuality` observation identifies the target row, policy
state, applied processing scale, smoothed completed GPU-job duration and measured
scope. Scopes distinguish source plus processing, an owned image-processing job,
final processing, an offline frame and affected external processing. Libplacebo
reports timestamp intervals from its actual rendering queue. The neural provider
reports completed MLX graph and conversion/publication intervals for image,
restoration, estimated-depth and paired generation jobs. Direct execution and
the ARM64 service use the same optional timing contract. Affected image rows and
pair/phase jobs form one sample for their real input, including image work
between generators. Exact cached copies do not reuse the original inference
cost or advance adaptation. A caller-command duration that includes a cross-queue
wait is not added to external intervals. The policy remains pending if any affected
external operation has no matching GPU timing. Missing timing is not displayed
as zero milliseconds. Opaque Vision/VideoToolbox flow used by temporal NR and
image SR has no complete GPU receipt; scene-SR uses a separate scene interface.
Their processing remains available while affected adaptive policies stay pending.
These fields use the existing context
lease and match its accepted plan identity.
Stopped or older observations remain historical. A prepared-revision mismatch
identifies previous settings. An Advanced execution's plan revision identifies
its ordered settings; Simple observations use both the prepared revision and
controls digest. Missing identities are labelled unconfirmed.
Current saved requests and per-row pending reasons are combined with
the latest preparation metadata without provider or model discovery.
Pending rows report retained resources only when the exact matching request has
acknowledged retention metadata.

`launcher:getGameGraphicsStatus` reads this state without building the effects
catalog. The inspector requests it only while Runtime status is expanded, the
inspector is visible and the game has graphics enabled. Original-renderer
filters report independently of the shared processor.

## Graphics status

The main process keeps one status record per game
(`src/main/graphics-status.js`). The record holds the desired plan revision,
the last publication, the latest native acceptance, the reason for any
difference between them and per-row states. Editor labels derive only from
this record.

| Phase | Meaning |
| --- | --- |
| `saved` | The plan is saved and the game is not running. A reason records the last failure or a change waiting for the next launch. A new edit or launch clears the previous failure. A row that cannot be prepared does not reject a stopped game's plan; the launch bypasses it and reports it. |
| `deferred` | The running game keeps its current graphics; the plan applies on the next launch. A game started without live graphics editing reports this immediately. |
| `preparing` | The running game's plan is being prepared, retried or published, or native code reports fresh preparation for the exact published revision. Previously completed work does not confirm the candidate. |
| `published` | The plan was committed to the running game and awaits native acceptance. |
| `applied`, `partial` | Native code accepted the published plan; `partial` lists the reasons of rows that are pending or not running. |
| `rejected` | Preparation or publication failed. `retained` names a previously accepted graph that remains active. |
| `unconfirmed` | The game did not report the publication within the fast observation window. The latest native frame reason is included when available. A later acceptance still moves it to `applied`. |
| `invalid` | The saved plan cannot be read. Editing is blocked until Clear effects, and launches bypass shared graphics. |

Row states are `active`, `off`, `pending`, `retained`, `failed` and
`bypassed`. A `bypassed` row was left out of the running plan with its reason,
such as a saved row that could not be read or a row that breaks the order; the
other rows run and the phase is `partial`. A row that the accepting contexts
report as bypassed or failed with a reason, such as missing renderer depth,
motion or jitter, an unsupported capability or busy image capacity, is also
`bypassed` with that reason once this lasts one second without the row
completing a frame. A row they report as still preparing with a reason, such
as a neural provider warming up, is `pending` with that reason in the same way.
A shorter bypass, such as busy capacity during a change, is not reported. The acknowledgement of a revision waits out that second for a
row that is not running, reading the rows from the contexts that accepted the
revision, so a context that still shows the previous revision does not hold
it back. When the confirmation window ends during that second, or acceptance
arrives after it, the revision applies at once with the rows known not to run
as `bypassed`, and the outcome is updated when the second ends. Later status
reads update the row the same way
when it stops or resumes running under the accepted revision. A row that no
current context reports keeps its status. A live edit that cannot be prepared
for a row whose earlier version the running game accepted republishes that
accepted version instead. The row reports `retained` with the edit's reason,
and the saved plan keeps the edited values, which the next publication
prepares again. A model download for a pending row
reports the `acquiring` phase. A failed publication restores the record's
`published` entry to the publication that was running before it.

Off and an empty plan are publications like any other: they are applied when
native code acknowledges their document revision. Native code acknowledges a
graph without processing as pass-through while the status lease is held, and
every live publication primes that lease before it is committed. The game's
selected window acknowledges it every 250 ms without drawing, so a route that
stops at Off, such as a browser stream, or an idle game still confirms it.
A game that has not processed since launch, such as one launched Off, opens
the leased status page from the same tick, at most once per second, without
recording frames.
When processing resumes, that window context is retired. A retired context
records Stopped whether or not processing or a lease is active, so it never
counts as drawing.
A Metal game drawable request that returns none, or waits at least 500 ms,
during image processing marks its layer as stalled. Without a later request
that completes within 500 ms, a separate context for that layer records the
current plan revision as Prepared, without accepted resources, every second.
It neither fails nor votes on acceptance. Its reason names the observed wait
and that the change applies if the game draws again, so a publication made
during the stall becomes `unconfirmed` with that reason, and a later acceptance
still applies it. The first stall of each layer is logged.
The window of each such layer is watched through its AppKit occlusion
notification, and diagnostics record its initial state and each change as a
`window-hidden` or `window-visible` state of the selected window. Some engines,
such as Godot 4, stop presenting while macOS reports their window hidden
(fully covered, minimized or on another Space), and can still render frames
that never present. While image processing is active, every watched game window
is hidden, no virtual output window is in use and no game drawable request has
completed within 500 ms for a second, the same layer context records Hidden
(phase 9) every second with the reason that the game window is hidden and the
change applies when it is visible again. No revision is accepted while a Hidden
record is current, so a publication made meanwhile becomes `unconfirmed` with
that reason even when another context keeps encoding frames. The next game
drawable request that completes within 500 ms records Prepared without a reason
on that context, which ends the hold at once. Without such a request the
record lapses six seconds after the window is visible again.

Acceptance counts the contexts that are drawing. While a request waits for a
revision, a context that records nothing for 500 ms after the request, such as
one that stopped processing after an Off, no longer holds back the contexts
that report the new revision. The same applies once its last record trails
another context's by 500 ms, such as a final pass-through acknowledgment just
after an On. It takes part again with its next frame. A context that has never
accepted a revision and reports no frame phase does not vote. An acceptance of
another revision, before or during that wait, does not end it.

A revision settles once. Publishing the same revision again for the same
desired plan keeps its `applied`, `partial`, `rejected` or `unconfirmed`
outcome; no later window or timer moves it back. A late acceptance still moves
`unconfirmed` to `applied`. A repeated acknowledgement that changes nothing
sends no status event.

Each outstanding publication has a fast confirmation window: 5 seconds, or 30
seconds when it adds a neural or model row or changes a virtual source. Fresh
native Preparing for the matching launch and revision extends that window to
120 seconds from publication. Repeated reports do not restart it. Afterwards,
known preparation stays Preparing and the existing observer checks metadata
every five seconds; a valid late acceptance still applies. An absent
acknowledgement uses the diagnostic `unconfirmed` state. Neither observation
expiry nor this label invalidates the graph. Native Failed reports the actual
error, while the prior accepted graph remains available. Absent, stale or
unrelated progress cannot claim preparation or acceptance. A newer
desired plan replaces the record's sequence; events from earlier sequences are
ignored. A running session binds the record to its launch and process. A
process can be registered before its launch records the process identity, so
an unbound session is read again for a few seconds and on each status read.
Once bound, a launch that prepared the current saved plan is that plan's
publication: rows the launch bypassed are `bypassed` with their reasons, and
native acceptance of the launch document moves the record to `applied` or
`partial`. A launch plan that needs no processing, such as Off, is `applied`
with its rows `off` as soon as the launch binds, without native acceptance.
When the session ends, a publication
in progress becomes `saved` with a next-launch reason. No timer runs for a
settled game.

A live publication needs native acceptance of the running graph to keep its
unchanged rows. When that acceptance is not available within its wait, because
the game has not drawn a frame yet or another reader holds the status lease,
the publication is tried again after 1, 2 and 4 seconds. A newer desired plan
ends the schedule. After the last attempt the plan is `deferred` with the
reason. One shared bounded schedule (`src/modules/shared/bounded-retry.js`)
serves this retry and the session binding retry.

`launcher:getGraphicsStatus(gamePath)` returns the current record.
`launcher:graphicsStatus` delivers each change to launcher windows as
`{gamePath, status, plan?, activeLaunch?}`, where `plan` accompanies a new
desired plan and `activeLaunch` identifies the running launch bound to the game.
Bursts are coalesced per game, with terminal phases sent immediately. The preload
exposes `getGraphicsStatus(gamePath)` and `onGraphicsStatus(callback)`, which
returns an unsubscribe function; this is the renderer's only graphics status
channel.

Native acceptance is read through a single function,
`effects/runtime.js` `acceptance`, which both live projection and the status
record use.

## Immutable launch selection

A running launch retains its admitted processor payload, manifest and helpers.
Publishing another included version changes the selection for later launches;
live discovery, compilation and resource preparation keep using the running
launch's payload. The binding belongs to launcher-owned storage, separate from
the game's writable controls. A game-provided file path cannot select a compiler
or compute-host executable.

## Sources, build targets and delivery

Graphics processors, shader helpers and the included shader collection are app
components. They run offline and follow MacLauncher updates. Runtime selection
does not require a graphics download. Licensed Lossless Scaling model import
remains a separate explicit operation.

Consumed Git sources have exact public origins and commits, through pinned
submodules or explicitly declared provider build inputs. Owned recipes and
overlays remain outside upstream checkouts. The production CMake tree is assembled by
`src/modules/shared/reshade/native/materialize-source.mjs` from the owned base,
registered overlays and exact processor Gitlinks. CMake builds `reshade-macos`,
`fx-compile`, `shaderc-offline`, `maclauncher-graphics-video` and the metadata-only
`maclauncher-graphics-hardware` query as production targets.
`scripts/build-graphics-runtime.mjs` builds these targets and the provider
recipes declared in `scripts/graphics-runtime.json`, then stages the component.
Compilation maps source and build paths to fixed prefixes, and links use small
arm64 Objective-C selector stubs, whose order is stable between links. The same
pins, SDK and linker therefore produce identical core binaries in any build
directory.
The complete MetalFX surface is built with the macOS 27 SDK. Runtime availability
guards keep the core deployment target separate from each operation's OS and GPU
requirements.
The Slang provider uses librashader 0.12.1 with its unchanged baseline C ABI and an
additive Metal named-input and uniform-snapshot API. Binary inputs retain exact artifact hashes,
architecture and macOS requirements. An optional provider's newer platform floor
does not change the baseline FX or Slang library's platform requirements.
Its sealed native files declare `optionalLoad: {architectures, minimumMacOS}`;
the launcher loads them only when those requirements match the game process.
Packaging verifies every file's hash, real CPU slices, signature and load-command
floor, including optional files. Required images still cover the package's
baseline architectures and macOS version.
The upstream inventory and component notices record their source and license
identities.

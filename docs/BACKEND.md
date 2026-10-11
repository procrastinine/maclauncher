# Shared launcher backend

`src/core/launcher.js` provides game execution independently of the Electron launcher.
Native engines run as native macOS processes. Web engines can use a standalone Electron
game host; Chromium remains a runtime dependency for those games. There is no Wine or
external VM fallback. Modules continue to own all engine-specific decisions and staging.

Electron game children receive an explicit application entry point in both source
and packaged launches. This also supports development bundles with a custom name.
The launcher's development-server URL and Node-mode environment are removed from
the child. Startup succeeds only after the child reports a loaded game window.

## Command line

```sh
pnpm launch --game /path/to/game
pnpm launch --game /path/to/game --runtime mkxpz --wait
pnpm launch --game /path/to/game --yes
pnpm launch --game /path/to/game --offline
pnpm launch --game /path/to/game --inspect
pnpm launch --game /path/to/game --user-data /path/to/launcher-data
pnpm launch --game /path/to/game --action gdreDecompile --payload '{"filePaths":["/path/to/script.gdc"]}'
```

`--inspect` is read-only: it detects metadata and resolves settings without importing,
staging, extracting, spawning games or creating launcher files. Normal launch imports
or refreshes the matching per-game record. Existing game IDs, save overrides, runtime
settings and module merge hooks are retained. Shared offline installer containers are
unpacked by the import backend, then return to normal engine detection. Other executable
containers are staged by their engine when needed. Windows code is never executed to
extract either kind.

An explicit `--runtime` is strict. Play selects a compatible exact version, prompts
before a required download, installs it globally, and prepares the original game
automatically. Bundled installation needs no download prompt. Module compatibility
checks precede installation; automatic installs preserve global runtime defaults
and unrelated game edits. Ordinary startup and inspection stay offline.

Modules can declare `runtime.prerequisites[runtimeId]` as a list of
`{ managerId, runtimeId, sectionId? }` host requirements. Each uses its own
per-game runtime selection and the manager's global defaults. The backend plans
the primary runtime and these prerequisites, obtains all required download
consents, then installs each missing selection once before game preparation.
Declining any consent cancels the launch before those installations begin.

The CLI prompts on a terminal; `--yes` permits required downloads and `--offline`
skips automatic installation/preparation. Noninteractive callers receive a clear
instruction instead of an unseen prompt. Apple's Rosetta license requires explicit
`--yes --accept-runtime-licenses`; its system package version is separate from the
macOS version. Cancellation neither starts a game nor records it as played.
The Electron binary is resolved from installed files, avoiding Electron's automatic npm-entry download.

`--wait` creates a separate process group, retains the child, forwards SIGINT/SIGTERM to the group and returns its exit status. Native
hooks using the injected spawner inherit output; module-owned wrappers may manage output
independently. Without `--wait`, processes detach as they do in the launcher. Diagnostic
logs use stderr, leaving `--inspect` and action result JSON on stdout.

Module actions are the existing actions, with the same effects and prerequisites. File
selectors require supplied paths or a UI adapter. Reveal actions require a shell adapter;
optional icon conversion is skipped without one. This does not introduce new editors or
decompilers.

## Service contract

### Electron worker adapter

`backend-worker-client.js` supplies asynchronous RPC and independent per-game/per-runtime
worker lanes. `backend-operations.js` owns metadata, launches, runtime actions, module
tools, patching and save work in plain Node. `backend-worker.js` dispatches requests;
none imports Electron. Native dialogs, consent and reveal actions return through async
host callbacks. Running-process/save-root state propagates across workers, and active
game workers stay alive until their owned processes exit. Idle workers are bounded
and disposed. One failed manager produces that manager's error snapshot rather than
rejecting the complete library state.

Within one backend host, game operations reserve their library identity through
preparation and process exit. `removeGameData(entry, { trash: false,
ignoreMissingSource: false })` requires exclusive access, rereads the persisted
record and checks that launches, tools and save actions have finished. It runs
runtime/module cleanup in the game's worker; an explicit Trash request also uses
the host's Trash callback. Library records are removed only after cleanup.

Stop signals the owned process group when available, otherwise the tracked child
PID; it does not signal an unrelated launcher group or existing application.
`game-process-events.js` observes terminal state independently of the UI, including
processes that exited before worker IPC delivery. Nonzero exits, signals and native
process errors reach the launcher's existing error banner. Normal quit and an
explicit Stop clear the running state without a failure message or recovery prompt.

`native-focus.js` waits asynchronously for a visible window belonging to the launched
process, verifies its executable and launch time, then makes at most one AppKit
activation request and checks foreground ordering. An owned window is sufficient
even when the runtime uses its own event loop. Exit cancels the wait, and changing
focus to another application cancels activation. This helper uses neither Electron
nor Accessibility and does not change system preferences.

Electron's `buildState` reads in-memory records and cached module/runtime snapshots;
it does not resolve a runtime or re-extract icons. Persisted display snapshots allow
the library to appear before offline backend inventory finishes. They are display
data only: launch/install still performs full backend compatibility/hash checks.
Independent runtime jobs must not block library selection or another game's lane.

`importEntry` reports generic `importProgress` events through the library worker.
`cancelImport(inputPath)` aborts its owned native reader and waits for staging cleanup.
The host's import queue retains FIFO persistence and deduplicates pending paths;
queued cancellations never start backend work. Completed installer generations live
inside per-game data and can be reused after an unsupported-engine result. No engine
name or installer format appears in the Electron import/cancel adapter.

`game-metadata.js` persists per-game detection, icon and save facts in
`userData/games/<id>/metadata.json`. Scoped `file-observations.js` records source reads,
directory observations, absent paths and filesystem identities, including module
reads outside the shared detection helpers. Cache reuse checks these observations
and relevant runtime/module settings rather than parsing the archives again.
Source changes, an absent file appearing, settings affecting facts, or
backend source changes invalidate the cache. Notes, last-played bookkeeping and an
unrelated runtime setting do not. New imports use one detection result and preserve
the identity of an existing canonical game.

CLI and worker hosted launches share
`hosted-process.js`: a token matches the startup session, and the child reports ready
only after its real game BrowserWindow finishes loading. Early host/load/renderer
errors, exits and the 30-second startup timeout reject before successful launch or
last-played bookkeeping. Timeout cleanup signals only that owned startup child.
Visible errors remain compact; bounded 32-KiB stdout/stderr tails are retained in
structured diagnostics and worker logs (`--debug`/`--wait` expose CLI diagnostics).
Other module-owned hosts may supply their own ready-report validator while Electron
keeps its strict default. The small dependency-free `hosted-startup-reporter.js` can
be copied into a private runtime wrapper; original game files remain untouched.
Electron waits for main-frame loading to stop after `loadURL` resolves; the brief
interval between those events is not a startup failure. The CLI explicitly selects
the standalone host entry. Detached hosts tolerate closed startup output pipes so
later game logging cannot interrupt play with an uncaught pipe error.

```js
const { createLauncher } = require("./src/core/launcher");
const launcher = createLauncher({ userDataDir, logger });
const settings = launcher.loadSettings();
const entry = await launcher.resolveEntry(gamePath, { settings });
const { child, runtimeId } = await launcher.launchEntry(entry, { settings });
```

`createLauncher` accepts injected registry, UI services, process spawn/options,
`launchHosted(entry, runtimeId, context)`, download and prerequisite-consent callbacks,
and entry/runtime/preparation state callbacks. The Electron
launcher injects its adapters and delegates actual launch dispatch to this service.
Preparation callbacks apply only to game launches. Manual module tools can report
their own progress without marking that game as starting or leaving Play disabled.

`getLaunchContext` supplies settings, module settings, runtime settings, cheat-file path,
tools visibility, checked process launcher, `ensureRosetta`, prerequisite consent,
save-write guards/snapshot hooks and state callbacks. Checked processes receive this
game's prerequisite context, including tools that invoke Intel executables through a shell.
Entry patches are limited to content root, default save directory, module data and
runtime data. Library identity remains
stable. Long-running action writes merge only changed settings/record fields into
current disk state so unrelated concurrent edits survive. Runtime settings use schema defaults → per-runtime disk defaults → module
settings → per-game settings. Cache entries distinguish schemas sharing a runtime ID;
reads never rewrite defaults. Explicit metadata writes use a temporary file and rename.

Module `prepareInput(entry, context)` hooks share writable-input preparation across imports, launches, tools and direct save actions. They keep the persisted source identity stable and may return a transient content view. `readOnly: true` resolves existing paths without creating output; cancellation uses the supplied signal. See the [module contract](MODULES.md#module-hooks-mainjs) and [input storage](GAME_PREPARATION.md#writable-input-views).

Resolution uses asynchronous staged detection when available. A caller may reuse a matching successful `detectionReport` in `resolveEntry` to avoid duplicate probes. CLI inspection returns trace/candidates/version evidence. Shared `explainDetection` and `removeAppQuarantine` actions work for applicable modules without engine branches.

Native Steam API preparation also lives in the shared Node backend. Modules supply
positive consumer evidence and exact API/CPU requirements through
`getSteamApiRequirement`, or call `context.prepareSteamApi` during their own launch
staging. Ordinary games and unrelated tools skip it. The resolver prefers a matching
game-supplied Mac library, then checks the included helper's pinned source, payload,
architecture, interface versions and actual exported symbols. Library aliases are
small per-game symlinks to one shared binary; offline configuration and persistent
state remain under that game's data directory. Child environments preserve other
runtime helpers without changing the launcher environment. Encrypted-ticket
libraries, Lua/NW.js/JNI bridges and custom engine builds have separate ABIs and
dependency checks; renaming a Steam DLL cannot supply those components.

Supported bridge ABIs are explicitly listed in the shared
[`profiles.json`](../src/modules/shared/runtime/steamworks/profiles.json) catalog.
Each profile pins the helper source and binary, bridge identity, CPU, exact
interface versions and probe sources. ABI profiles do not replace the
sealed native payload. Java's steamworks4j 1.9 uses an Intel JVM; 1.10 supports
both CPU architectures. LÖVE's LuaSteam bridge binds the selected host's Lua 5.1
state. The included helper provides local Steam state; online services require the genuine Steam API.

`saveService` supplies declared-file listing/import/export, bounded JSON documents with source hashes, and snapshot/restore transactions under Node. Dialogs/external-editor opening remain shell adapters. See [save action payloads](SAVE_SNAPSHOTS.md). Tracked processes protect shared real save roots, including separate game records.

`runRuntimeManagerAction` in `src/core/runtime-manager-service.js` shares catalog
refresh, install/import, installer setup, defaults and installed-version library
actions between adapters. File picking, consent and settings persistence are injected;
headless imports supply `runtimePath` directly. Installed actions target one exact
section/version, such as Ren'Py SDK Live2D import, and preserve SDK defaults.

### Shared runtime coordination

`runtime-coordinator.js` is a pure Node service shared by the backend worker lanes.
It serializes mutations of overlapping manager/version artifacts; downloads,
extraction and compatibility checks remain in workers. A waiting installer rechecks
the exact installed version before doing work, so concurrent Play and Install reuse
one installation. Catalog reads and unrelated manager/version jobs remain independent.
Removal uses a matching installed row rather than a caller-supplied directory, and
active runtime leases reject replacement, removal and shared library changes.

Leases follow the module's actual selection and selected executable/file arguments,
including section, variant and shared source. A module that launches a private copy
calls `await context.useRuntime({ managerId, version, sourcePath })`
with its shared base before staging; `sectionId` and `variant` are optional identifiers.
`resolveSelection` observations retain the final
compatible choice; they never substitute global defaults. Leases survive until the
owned child/window exits; if a worker closes while its child lives, the host retains
the lease until that PID exits. Failed or cancelled launches release their claims.
Shared assets use `context.withRuntimeMutation({ managerId }, async () => { ... })`
for manager-wide removal or replacement. A launch may finish its own preparation
before spawning; reservations from other launches or running games remain protected.
Nested setup can extend its mutation scope; a conflicting upgrade fails rather than
waiting on a lock it already holds.

`createLauncher`, `runRuntimeManagerAction` and `createBackendService` accept an
injected `runtimeCoordinator`. Plain Node callers within one host share the default
coordinator for their user-data directory; worker adapters expose only asynchronous host callbacks.
Settings changes use the same host's short fresh-read/merge/atomic-write transaction,
applying changed fields so independent runtime defaults and delayed tool edits survive.
No download, dialog or long preparation runs inside that transaction.
The Electron adapter uses `settings-snapshots.js` to track effective settings when
loaded. A later save normalizes fresh disk state and merges only the caller's edits;
implicit defaults cannot overwrite a newer explicit preference. The saved object is
refreshed with committed state, so a repeated save does not replay earlier edits.

Pure library ordering, entry merge, runtime selection and game-store functions live under
`src/core/`. The old `src/main/` paths retain compatibility exports. Renderer and launcher
window state stay in their respective adapters.

## Web-game host

`src/main/bootstrap.js` selects the launcher or `--maclauncher-runtime-host` entry in
packaged apps. `src/runtime/electron-game.js` initializes the game host without importing
`src/main/main.js`. `electron-host.js` receives Electron APIs rather than importing them
at module load, so registry discovery remains possible in Node.

The host maintains per-game partitions, existing preloads/cheats, window configuration,
keyboard/menu/IPC support, offline restrictions and opt-in fallback prompts. MV/MZ opt
into save-directory injection through their manifests. Its local server streams assets,
supports correct byte ranges and HEAD, and checks paths against the real game root.
Modules may declare `getContentReadRoots(entry, context)` for original immutable
assets linked by a private view; undeclared paths retain the contained-root policy.

Other interfaces can invoke the same CLI and services without reimplementing engine behavior. Web games retain their Chromium runtime dependency.

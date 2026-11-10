# Backend and command line

Game detection, preparation and launch, along with module actions, do not depend on the Electron launcher. That work runs in MacLauncher's shared backend, `src/core/launcher.js`. The Electron app calls the backend through backend workers, and the `pnpm launch` command line calls it directly. Other interfaces can therefore use the same command line and services without reimplementing engine behavior.

How a game runs depends on its engine. Native engines run as native macOS processes, whereas web engines can use the standalone Electron game host, so Chromium remains a runtime dependency for those games. Compatible Windows games can use the downloadable [Sikarugir (Wine)](../runtimes/SIKARUGIR.md) or a locally registered [CrossOver](../runtimes/CROSSOVER.md) application. The engine-specific decisions belong to modules, which also stage their own files; the [module system](MODULES.md) defines their hooks.

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

Behind `pnpm launch` is `scripts/run-game.mjs`, a plain Node entry point that detects the game, imports it and launches it through `src/core/launcher.js`.

| Option | Effect |
| --- | --- |
| `--game <path>` | The game file or folder to detect, import and launch |
| `--runtime <id>` | Requires this runtime. The selection is strict, and the runtime reports its own input and installation requirements. |
| `--wait` | Keeps the game process attached and returns its exit status |
| `--yes` | Permits required downloads without a prompt |
| `--offline` | Skips automatic installation and preparation |
| `--inspect` | Detects the game and resolves its settings without changing anything |
| `--user-data <dir>` | Uses a separate launcher data directory, which keeps settings, imports, extracted files and saves apart from the normal library |
| `--action <id> [--payload <json>]` | Runs an existing module action instead of launching |
| `--accept-runtime-licenses` | Together with `--yes`, accepts a system runtime license that requires explicit consent, such as Rosetta's |
| `--debug` | Turns on diagnostic logs |

### Import and inspection

`--inspect` is read-only. It detects metadata and resolves settings without importing, staging, extracting, spawning games, running import hooks or creating launcher files. It returns the detection trace, the candidates and the version evidence.

A normal launch imports the game, or refreshes its existing per-game record. The refresh keeps the existing game ID, save overrides and runtime settings, and module merge hooks still apply. Executable containers are extracted without running any Windows code. The import backend unpacks shared offline installer containers and then runs normal engine detection on the result, while other executable containers are staged by their engine when needed.

### Runtime installation and consent

A command-line launch selects, downloads and installs runtimes in the same way as **Play**, following the [download rules](../runtimes/README.md#downloads-and-offline-use) of the runtime system. Module compatibility checks run before installation, and automatic installations keep global runtime defaults and unrelated edits to the game. `--inspect` uses no network. [Runtime installation](#runtime-installation) describes host prerequisites and manager actions.

On a terminal, the command line asks for consent. Noninteractive callers receive an instruction instead of a prompt nobody would see. Apple's Rosetta license requires both `--yes` and `--accept-runtime-licenses`; the Rosetta system package has its own version, separate from the macOS version. Cancelling neither starts the game nor records it as played.

### Processes and output

With `--wait`, the command line starts the game in a separate process group, keeps the child, forwards SIGINT and SIGTERM to the group and returns the exit status. Native hooks that use the injected spawner inherit the output, while a module's own wrappers can manage their output themselves. Without `--wait`, processes detach as they do in the launcher.

Native engines run directly from Node. Hosted web games use `src/runtime/electron-game.js`, which creates no launcher window and no launcher IPC endpoints. The command line finds the Electron binary among the installed files, which avoids the automatic download in Electron's npm entry point.

Diagnostic logs go to stderr, which keeps the `--inspect` report and action results as JSON on stdout.

### Module actions

`--action` runs a module's existing action with the same effects and prerequisites as in the launcher. Actions can modify game files and can require installed tools, and download and patch actions keep their explicit-action behavior. File selectors require supplied paths or a UI adapter, and reveal actions require a shell adapter. Without a shell adapter, optional icon conversion is skipped.

### Shortcuts

A shortcut starts one game without opening the library window. The inspector's Shortcut action saves it as an executable `.command` file under a chosen name and location. The file runs `src/core/game-cli.js` with the current Electron executable in Node mode, using the source files during development and the included archive in packaged builds. Hosted games open only their game runtime. A shortcut keeps the library data directory and reads the game's current saved runtime, version, settings and save locations, so it matches Play without a separate Node installation.

## Node API

```js
const { createLauncher } = require("./src/core/launcher");
const launcher = createLauncher({ userDataDir, logger });
const settings = launcher.loadSettings();
const entry = await launcher.resolveEntry(gamePath, { settings });
const { child, runtimeId } = await launcher.launchEntry(entry, { settings });
```

Each caller adapts the backend by injecting services into `createLauncher`: the registry, UI services, process spawning and spawn options, `launchHosted(entry, runtimeId, context)`, download and prerequisite-consent callbacks, and callbacks for entry, runtime and preparation state. The Electron launcher injects its adapters and leaves launch dispatch to this service. Preparation callbacks apply only to game launches, so a manual module tool can report its own progress without marking the game as starting or disabling Play.

Pure functions for library ordering, entry merging, runtime selection and the game store also live under `src/core/`, and the older `src/main/` paths keep compatibility exports that load them. Renderer and launcher window state stay in their own adapters.

### Entry resolution

`resolveEntry` turns a game path into a library entry. It uses asynchronous staged detection when that is available, and a caller that already holds a matching successful `detectionReport` can pass it in to avoid repeating the probes. The shared `explainDetection` and `removeAppQuarantine` actions work for every applicable module without engine branches.

Module `prepareInput(entry, context)` hooks prepare writable inputs in the same way for imports, launches, tools and direct save actions. They keep the game's saved source paths unchanged and can return a transient content view. With `readOnly: true`, a hook resolves existing paths without creating output, and cancellation uses the supplied signal. The [module contract](MODULES.md#module-hooks-mainjs) and [input storage](../library/GAME_PREPARATION.md#writable-input-views) define these hooks and their layouts.

### Launch context

Module hooks receive their launch context from `getLaunchContext`, which supplies settings, module settings, runtime settings, the cheat-file path, tool visibility, the checked process launcher, `ensureRosetta`, prerequisite consent, save-write guards and snapshot hooks, and the state callbacks. Checked processes receive the game's prerequisite context, including tools that run Intel executables through a shell.

A module can patch only these entry fields: the content root, the default save directory, module data and runtime data. The game's library ID and paths stay the same. Runtime settings are resolved from four layers, described in [runtime settings](DATA_MODEL.md#runtime-settings). The cache of resolved settings keeps apart schemas that share a runtime ID, and reading settings never rewrites defaults.

## Runtime installation

A runtime can depend on other runtimes being present on the host. Modules declare these dependencies in `runtime.prerequisites[runtimeId]`, a list of host requirements of the form `{ managerId, runtimeId, sectionId? }`. Each requirement uses its own per-game runtime selection and its manager's global defaults. The backend plans the primary runtime together with these prerequisites, obtains every required download consent and then installs each missing selection once, before game preparation. Declining any consent cancels the launch before installation begins.

`runRuntimeManagerAction` in `src/core/runtime-manager-service.js` gives every adapter the same catalog refresh, install and import, installer setup, default selection and installed-version library actions. File picking, consent and settings persistence are injected, and headless imports pass `runtimePath` directly. Manager declarations change these actions:

| Declaration | Effect |
| --- | --- |
| `catalog.delivery: "local-files"` | The manager copies local files and inspects their version. Its panel shows the imported files, import and removal, without a download or version selector. |
| `catalog.delivery: "local"` | The manager registers a local application and keeps it in place. |
| `catalog.importVersionRequired` | The imported artifacts do not identify their own version, so the Runtimes selector supplies `version` with the import. |
| `createPinnedNativeManager({ importLocal: true })` | Enables explicit registration of a local executable or app, with native architecture validation and checksum tracking. Removing the registration keeps the external files. |

Fixed built-in managers do not opt into user-facing management. Installed-version actions target one exact section and version, such as importing Live2D into a Ren'Py SDK, and keep the SDK defaults.

## Shared runtime coordination

Each game and each runtime has its own backend worker, so several workers can use or change the same runtime at once. They share `src/core/runtime-coordinator.js`, a pure Node service that serializes changes to overlapping manager and version artifacts, while downloads, extraction and compatibility checks stay in the workers. A waiting installer checks the exact installed version again before doing any work, so a concurrent Play and Install use one installation. Catalog reads and jobs for unrelated managers or versions run independently. Removal works on a matching installed row, never on a directory supplied by the caller, and active runtime leases block replacement, removal and changes to shared libraries.

A launch holds runtime leases on what it uses. Leases follow the module's actual selection and the executable and file arguments it selects, including the section, variant and shared source. A module that launches a private copy calls `await context.useRuntime({ managerId, version, sourcePath })` with its shared base before staging; `sectionId` and `variant` are optional. Observations from `resolveSelection` keep the final compatible choice and never substitute global defaults. A lease lasts until the child process or window that the launch started exits. If a worker closes while its child is still running, the host keeps the lease until that PID exits. Failed or cancelled launches release their claims.

To remove or replace shared assets across a whole manager, a module wraps the change in `context.withRuntimeMutation({ managerId }, async () => { ... })`. A launch can finish its own preparation before spawning, and reservations held by other launches or running games stay protected. Nested setup can extend its mutation scope, and a conflicting upgrade fails instead of waiting on a lock it already holds.

`createLauncher`, `runRuntimeManagerAction` and `createBackendService` accept an injected `runtimeCoordinator`. Plain Node callers in one host share the default coordinator for their user-data directory, and worker adapters expose only asynchronous host callbacks.

### Settings writes

Each settings change is a short transaction in the same host, which reads the current file, merges the changed fields and writes the result atomically. Independent runtime defaults and delayed tool edits therefore survive. No download, dialog or long preparation runs inside the transaction. The Electron adapter uses `settings-snapshots.js` to track the effective settings at load time. A later save normalizes the current file and merges only the caller's edits, so implicit defaults cannot overwrite a newer explicit preference. The saved object is then refreshed with the committed state, and a repeated save does not replay earlier edits. [Writes and damaged files](DATA_MODEL.md#writes-and-damaged-files) describes the rules for every stored document.

## Electron worker adapter

The Electron app runs backend calls in Node worker threads. `src/core/backend-worker-client.js` provides asynchronous RPC and an independent worker for each game and each runtime, which it starts when first needed. Inside the workers, `backend-operations.js` handles metadata, launches, runtime actions, module tools, patching and save work in plain Node, and `backend-worker.js` dispatches the requests. The operations also include [derived data upkeep](DATA_MODEL.md#derived-data-upkeep) (`maintainStorage`), which runs in a worker of its own. None of the three files imports Electron, so native dialogs, consent and reveal actions go back to the host through asynchronous callbacks.

Running-process and save-root state is shared across workers. A game's worker stays alive until the processes it started exit. Pending completion diagnostics can keep an exited process's worker for up to 1.5 seconds while its output drains, and the game's running state clears immediately. The number of idle workers is limited, and idle workers are disposed. A manager that fails produces an error snapshot for that manager instead of failing the whole library state.

After the startup runtime inventory, the adapter starts one spare worker and asks each module's optional `warmBackendLane` hook to read what its games share, such as the translator choices of the installed default Wine runtimes. The next game that needs a worker receives the spare, and another spare starts two seconds later, so a game's first inspector request does not wait for a worker to start.

Each worker counts runtime inventory changes. A runtime action, a runtime or settings change, and a runtime state whose installed or included rows differ from the worker's previous state for that manager advance the count in the worker that reports them, and the adapter tells every other worker to advance its own. Translator choices, inspector rows and graphics inputs reuse one read of installed runtimes within a worker until the count changes, or until the runtime settings or the selected Wine installation differ. Included and managed translator files are described from facts kept under `cache/translator-descriptions` in the profile, recorded the first time a component is read and again when one of its files changes, so a new worker reads no translator binaries for these lists. Play always reads installed runtimes again and inspects the native libraries it places. When MacLauncher becomes the active app, the state worker reads the runtime inventories again, one read at a time, so a runtime changed outside the launcher advances the count once its rows differ.

Modules can be imported both on the main Node thread and in backend workers. A module with its own worker uses a dedicated entry file, and only that entry file installs task handlers or closes its message port.

### State updates

Launcher windows receive state over two channels. Structural library and runtime changes arrive through `launcher:state`, while download, preparation, import and running-process updates use the smaller `launcher:activity` channel, and the renderer merges only those activity fields into its existing game and catalog objects. Activity that arrives before the first snapshot is buffered, and a newer full broadcast replaces an older pending snapshot. Settings, Runtimes, Credits and the other utility windows receive the state without library rows and icon previews. A new utility window reads its request with its first state, and a changed request, such as opening Runtimes on another manager, is sent only to that window. Only the Credits window collects acknowledgments.

Progress notifications are throttled. Byte and chunk updates are combined into at most four notifications per second for each operation, while phase changes and completion are published immediately. Each window has at most one unacknowledged activity message and one pending latest snapshot, and closing a window removes its subscription. Completed or cancelled operations clear their pending progress timers. Finished tool processes release their records, and late process messages go to a weak cache with a size limit.

Removing a library entry releases its cached inspector results in every window, and late tool responses cannot restore records for removed entries. Live-variable status polling waits for each reply before scheduling the next read. Explicit refreshes share an outstanding status request, and closing the editor stops its timer and ignores any late reply.

### Icons and logs

Module icon discovery, executable icon parsing and macOS icon conversion run in backend workers. Conversion has a fixed timeout, stops when an import is cancelled and removes its temporary files after success or failure. The launcher receives only the extracted image and caches a small preview.

Launcher and hosted-game logs use asynchronous 64 KiB queues with a size limit on each record and a visible count of dropped records. The shared profile log rotates at 2 MiB and keeps one previous file, and a normal shutdown flushes pending diagnostics before exit. An oversized log from an older version keeps only its most recent 2 MiB.

### Downloads

Runtime archives stream directly to temporary files, which are removed after a failure or cancellation. A connection that delivers no bytes for 30 seconds counts as stalled. A dropped or stalled connection, or an HTTP 408, 425, 429 or 5xx response, is retried after 1, 2 and 4 seconds within the same transfer. When the server provided a strong validator and supports byte ranges, a retry requests only the missing bytes (`Range` with `If-Range`); otherwise it starts over. A transfer that still fails after the last attempt reports its reason, and **Install** can start it again. Other failures, such as HTTP 404, end the transfer at once.

Buffered catalog responses, including decoded GitHub, Java, Godot, Ren'Py and NW.js pages, are limited to 32 MiB. The byte limit also applies to responses without a Content-Length header.

## Library records

Electron's `buildState` reads in-memory records and cached module and runtime snapshots, without resolving runtimes or extracting icons again. Saved display snapshots let the library appear before the backend's local inventory finishes. They are display data only, and launching or installing still runs the full backend compatibility and hash checks. Independent runtime jobs never block library selection or another game's worker.

Backend workers send each runtime state already encoded and limited to builds this Mac can run, and the main process stores and sends it unchanged; the display snapshot file records this format and a file in an older format is ignored. A library row whose icon file has not been decoded yet is marked pending and shows an empty icon tile, and a row whose icon file changed keeps its previous preview. The main process decodes these icons in slices of about 8 ms, then rebuilds the library state once with the 128-pixel previews, or with the module icon where a file is not a readable image. A decoding round whose results match the previews already shown does not rebuild the state. Each preview, and each unreadable result, is kept for that file's size and timestamps. Inode numbers are not compared, because Electron reports a new inode number on every stat of a file inside the app's ASAR archive, such as a module's default icon. At startup the first library state and the window's creation run as separate tasks.

Module checks behind a library row can read game files, so they run in backend workers. One queue per game runs its metadata refresh and runtime checks together as a single `libraryEntry` operation. At startup the main process checks each game's availability once, asynchronously, and passes the result to both steps, which do not repeat the check; an unavailable game keeps its recorded metadata. `resolveEntryChecks` in `src/core/launcher.js` returns the effective runtime, the applicable runtimes, whether the game can launch and whether its saves are in launcher data. Each row updates as soon as its own job finishes and keeps its previous result while a new one is computed. A game without a previous result first shows its stored runtime choice and the runtimes its engine declares. Runtime checks are invalidated by changes to records, relevant settings, installed runtimes or availability, but not by a refresh of a download catalog alone.

Runtime inventories, metadata refreshes, check results and availability changes arrive in bursts, and the main process rebuilds and sends the library state once per burst. Background jobs start in library order on three `library-view` workers. Selecting or playing a game moves its pending job ahead of the background work, and when all three of those workers are busy, a separate worker runs it. Duplicate requests share one job, and a request with changed inputs replaces the game's pending job. A failed job is logged with the game's name and the reason, and the other jobs continue.

`importEntry` reports generic `importProgress` events through the library worker. `cancelImport(inputPath)` stops the import's native reader and waits for its staging cleanup. The host's import queue starts imports in the order they arrive, up to three at a time, each in its own backend worker, so an import that waits for download consent or reads a slow drive does not hold up the others. It skips paths that are already pending, and cancelling a queued import never starts backend work. Adding a game writes only that game's record. Completed installer output lives inside per-game data and can be reused after detection finds no matching engine. The Electron import and cancel adapter names no engine or installer format.

`src/core/game-metadata.js` stores detection, icon and save facts for each game in `userData/games/<id>/metadata.json`. To tell whether those facts are still current, `file-observations.js` records what metadata analysis looked at: source reads, directory observations, absent paths and file-system identities, including reads that modules make outside the shared detection helpers. Before reusing the cache, the backend checks these observations and the runtime and module settings that affect them, instead of parsing the archives again. The cache is invalidated when a source changes, an absent file appears, a setting that affects the facts changes or the backend source changes. Notes, last-played times and unrelated runtime settings do not invalidate it. A new import uses one detection result, and an import of a game already in the library keeps that game's existing ID and record.

### Unavailable game files

`src/core/game-availability.js` decides whether a game's original files are on disk. It makes one `stat` of the game's root: the game path, or the import path when the game path is a launcher-owned copy such as an unpacked installer. It never reads the folder's contents. The check has a three-second limit and runs on a probe thread, independently of the shared filesystem queue. One probe thread answers checks in order. When a check takes longer than 250 milliseconds, that thread keeps the slow location and later checks move to a new thread, so a location that stops responding never delays checks of other locations. Only one check for a given path is outstanding at a time, and probe threads never keep the process running. Once a check has outlasted the limit, later checks report the location as not responding without waiting again. A synchronous variant serves the save service in backend workers.

Operations that read game files call this check first and fail with the error code `GAME_FILES_UNAVAILABLE` and a message that names the cause: metadata refresh for an existing game, `launchEntry`, `resolveEntry` for a game already in the library, module actions, `explainDetection`, patching and `selectSaveLocation`. Changes to notes, launch arguments, network access and the Steam client preference do not read the game's files and are not checked. While the files are missing, `graphicsInputs` returns only the runtime's declared inputs, `refreshSaveLocations` keeps the stored locations, and save operations use the locations stored with the record. They refuse a save folder inside the missing game root, because creating it would recreate an empty game folder in its place. Snapshot listing reads only launcher data.

In Electron, `src/main/game-availability-monitor.js` keeps the availability of each library game and adds it to the renderer state. It checks every game at startup, when a launcher window gains focus (at most every two seconds), before Play and when missing games are detected. Results apply in request order for each game. Library state building passes the cached result to module hooks as `entry.availability`, so runtime support and launch capability use recorded facts instead of looking at the paths of an unavailable game, and an icon stored inside the missing root is not read. When a game's files return, the monitor runs the same metadata refresh as startup for that game.

### Removing a game

Within one backend host, each game operation reserves the game's library entry from preparation until its process exits. `removeGameData(entry, { trash: false, ignoreMissingSource: false })` requires exclusive access. It reads the persisted record again and checks that launches, tools and save actions have finished, then runs the runtime and module cleanup in the game's worker. An explicit Trash request also uses the host's Trash callback. Library records are removed only after cleanup succeeds.

## Game processes

### Stopping

Stop first calls the runtime's optional shutdown callback, which has a time limit. The backend keeps that exact process binding and its game and runtime leases until cleanup settles, even if the controlling process exits earlier, and returns callback failures to the caller. Processes without a callback are stopped through their own process group when one exists, or else through the tracked child PID. Unrelated launcher process groups and existing applications are never signalled. Interrupting the command line uses the same runtime Stop path.

After a normal exit, the backend also waits on `child.runtimeRetirement` once the exit listeners have set it. Workers and the game, runtime and graphics leases stay held while the teardown runs. If retirement fails, the backend records the original error and keeps the leases for any remaining consumers.

### Exit reporting

`src/core/game-process-events.js` observes the final state of game processes independently of the UI, including processes that exited before worker IPC delivery. Nonzero exits, signals and native process errors appear in the launcher's error banner. Before reporting a failure, the launcher checks the game's files again; a game whose files are no longer on disk is reported as stopped because its files became unavailable, and no runtime recovery is offered. A normal quit and an explicit Stop clear the running state without a failure message or recovery prompt.

### Window focus

`src/modules/shared/runtime/native-focus.js` waits asynchronously for a visible window that belongs to the launched process and checks its executable and launch time. It then makes at most one AppKit activation request and checks the window order. A window owned by the process is enough, even when the runtime runs its own event loop. Process exit cancels the wait, and switching to another application cancels the activation. The helper uses neither Electron nor Accessibility and does not change system preferences. Activation and optional logging failures leave a successful spawn result intact, and process spawn errors keep the normal launch error handling. `focusOwnedProcess` makes the same single request for a process ID that the caller has just matched to its own launch, without an executable identity, and only while a named application, the launcher, is still frontmost. `wine-activation.js` uses it for CrossOver and Sikarugir games: it subscribes to Wine's distributed `WineAppWillActivateNotification` through the host's `systemPreferences` for as long as the launched process runs, ignores process IDs that are not descendants of that process, and handles one request per process at a time.

## Hosted games

### Startup

Electron game processes receive an explicit application entry point in both source and packaged launches, which also works for development bundles with a custom name. The launcher's development-server URL and Node-mode environment are removed from the child's environment.

Hosted launches from the command line and from workers share `src/core/hosted-process.js`. A token ties the child to its startup session, and the child reports ready only after its game BrowserWindow finishes loading. Early host, load and renderer errors, exits and the 30-second startup timeout fail the launch before it counts as successful or updates the last-played time. On timeout, cleanup signals only the startup child it owns.

Visible errors stay short. Structured diagnostics and worker logs keep the last 32 KiB of stdout and stderr, and `--debug` or `--wait` shows them on the command line. Other hosts that a module provides can supply their own ready-report validator, while Electron keeps its strict default. The small, dependency-free `hosted-startup-reporter.js` can be copied into a private runtime wrapper without touching the original game files.

Electron waits for the main frame to stop loading after `loadURL` resolves, and the short interval between those two events is not treated as a startup failure. The command line selects the standalone host entry explicitly. Detached hosts tolerate closed startup output pipes, so later game logging cannot interrupt play with an uncaught pipe error.

### Web-game host

A packaged app serves as both the launcher and the web-game host: `src/main/bootstrap.js` selects either the launcher entry or the `--maclauncher-runtime-host` entry. `src/runtime/electron-game.js` initializes the game host without importing `src/main/main.js`. `electron-host.js` receives the Electron APIs as arguments instead of importing them when the module loads, so registry discovery still works in plain Node.

The host keeps per-game partitions without an HTTP disk cache, the existing preloads and cheats, window configuration, keyboard, menu and IPC support, offline restrictions and opt-in fallback prompts. MV and MZ opt into save-directory injection through their manifests. The host's local server streams assets, handles byte ranges and HEAD requests correctly and checks every path against the real game root. A module can declare `getContentReadRoots(entry, context)` for original, immutable assets that a private view links to; undeclared paths keep the policy of serving only from the contained root.

## Graphics effects

A game record keeps its graphics settings in its `effects` plan, described in [effects plans](../graphics/EFFECT_PLANS.md), and effects are off by default. On Play, the shared effect service verifies the included native files, preprocesses and validates the shader and places the prepared state in the game's private data directory. `context.applyGameEnvironment(base)` applies the trusted environment for the child process only. Native spawning and the standalone Electron host use the same service, and Wine providers pass that environment through their launch wrappers. Inspection, runtime installation and decompilation never inject effects into helper tools.

Runtime entries declare `graphicsHost` as `window`, `remote` or `explicit` to choose their presentation integration, and the included graphics manifest lists the scaling and frame-generation support of each host. The inspector and launch preparation use the presentation capabilities that the selected host declares, and effect injection stays a separate setting.

- NW.js and Electron declare remote presentation, because their GPU helper supplies the window surface. They use the same spatial methods and installed models as direct window presentation. ONScripter-Yuri Web and Browser Woditor use the same remote integration through their NW.js and Electron hosts.
- Unity, Godot, LÖVE, MKXP-Z and OpenGMK declare direct window presentation for their Metal and hardware OpenGL rendering paths.

Source and output dimensions decide whether scaling is needed, and source-resolution controls are a separate setting from scaling. [Graphics and effects](../graphics/README.md) describes the shared methods, shader formats and temporal and video inputs.

### Diagnostics

When effects are enabled, the game keeps a small `launch.json` preparation record with the selected runtime, the preset, the adapter version and the preparation time. These environment variables turn on more diagnostics:

| Variable | Effect |
| --- | --- |
| `MACLAUNCHER_RESHADE_DIAGNOSTICS=1` | Native stage and CPU timing diagnostics, read when the launcher starts |
| `MACLAUNCHER_RESHADE_GPU_TIMING=1` | GPU timing. Each sample says whether it measures the effect alone or the game's complete command buffer. |
| `RESHADE_TRACE=1` | The native adapter log, which is also noted in the preparation record |

The timing streams write per-launch, per-process files in the game's effects directory and never record environment values or frame images. Ordinary launches leave all three off. Completed diagnostic streams keep at most 32 files and 8 MiB per game, and streams that belong to running processes stay available until a later launch.

## Steam API

Native Steam API preparation also runs in the shared Node backend. Modules supply positive evidence from the actual consumer, with its exact API and CPU requirements, through `getSteamApiRequirement`, or call `context.prepareSteamApi` during their own launch staging. Ordinary games and unrelated tools skip this step.

When choosing a library, the backend's Steam API resolver prefers a matching Mac library supplied by the game. Otherwise it checks the included helper's exact source, binary, architecture, interface versions and actual exported symbols. Library aliases are small per-game symbolic links to one shared binary, and the offline configuration and persistent state stay in the game's data directory. Child environments keep other runtime helpers without changing the launcher's own environment. Encrypted-ticket libraries, Lua, NW.js and JNI bridges and custom engine builds have their own ABIs and dependency checks, so renaming a Steam DLL cannot stand in for them.

The shared [`profiles.json`](../../src/modules/shared/runtime/steamworks/profiles.json) catalog lists every supported bridge ABI. Each profile records the exact helper source and binary, the bridge, the CPU, the exact interface versions and the probe sources. A profile describes an ABI; it does not replace the verified native helper package. Java's steamworks4j 1.9 runs on an Intel JVM, and 1.10 supports both CPU architectures. LÖVE's LuaSteam bridge binds to the Lua 5.1 state of the selected host.

The included helper provides local Steam state, and online services require the genuine Steam API. Only Play can start the Steam client. When the selected library is the game's own Steam API from a Steam library installation, including a native Mac app that ships it, and Steam is not running, the preparation follows the "Steam client on Play" choice: it asks through the download consent flow, starts the client after consent or with a standing Start automatically choice, and waits a limited time for the client to sign in. It never does this for the included helper. [Steam API support](../runtimes/STEAM_API.md) describes the client start and its consent.

## Saves

`saveService` lists, imports and exports declared save files, reads and writes JSON documents with a size limit and source hashes, and runs snapshot and restore transactions in Node. Dialogs and opening an external editor stay in the shell adapters. Tracked processes protect shared real save roots, including roots shared by separate game records. [Save snapshots](../tools/SAVE_SNAPSHOTS.md) describes the save action payloads.

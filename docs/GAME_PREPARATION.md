# Game preparation and storage

Import the original game folder, executable or supported package, then press Play. The
backend chooses a compatible runtime and asks before downloading a missing
runtime. Preparation runs as part of the same launch; it requires no separate
prepared game or manual extraction step.

Installed runtimes live under
`~/Library/Application Support/maclauncher/runtimes/`. Game-specific runtime
files live below `~/Library/Application Support/maclauncher/games/<gameId>/`.
Backend callers can select a different root with `userDataDir`.

## Writable input views

Modules that need writable scripts, configuration or portable saves prepare a private input view automatically for import, launch, tools and save operations. The library keeps the original game's identity and paths; the backend can pass a transient view to the runtime or tool.

Source-reading actions, including extraction, decryption and Steam identity detection, use the original content. Runtime, patch and plugin actions use the writable view.

Views live at `games/<gameId>/modules/<moduleId>/writable-input/files/`. They use real directories, private mutable files and links to immutable assets. Plugin and library changes atomically replace affected leaf links, preserving the original targets. Unchanged source and policy metadata reuses existing files, while portable saves survive subsequent launches.

Read-only backend calls can resolve paths and read an existing view without creating or copying files. Ren'Py reuses its existing SDK-specific project overlays. MKXP-Z executables and frameworks remain shared; RGSS save-file metadata is nonrecursive so root portable saves are handled separately from nested databases and assets.

## Original assets and private runtime files

- Ren'Py SDK projects keep real directories and private scripts, Python files,
  compiled bytecode, configuration, caches, logs and local save files. Archives,
  images, music and other immutable assets are linked to the original game.
  Each SDK version has independent compiled scripts and caches. Existing local
  saves seed the private save folder once; subsequent launches preserve updated
  saves. The usual `~/Library/RenPy/<save_directory>` remains the primary save
  location when the game declares it.
- Ordinary and patched NW.js projects link the original HTML, scripts and
  assets. The launcher writes its own small package manifest, injected runtime
  helpers and selected native-library replacements under the game's runtime
  directory. It does not copy the complete game.
- RGSS uses one shared MKXP-Z executable and native-library payload, with a tiny
  config directory for each launch. A sealed child-only helper redirects the
  runtime's exact app-config directory transition; other directory changes stay
  unchanged. Concurrent games have separate JSON, logs and launch records.
  Included and installed base apps stay unchanged, without per-game app copies.
  Required RTP packs download from the publisher after Play consent and are
  shared between games. Kawariki and the soundfont use a separate small shared
  generation; each config retains its paths across updates or repairs. See
  [MKXP-Z config isolation](runtimes/MKXPZ.md).
- A Construct or Tyrano `package.nw` directory is already readable and runs
  from that original directory. Status checks do not copy it. Tyrano's missing
  `$.userenv` compatibility fallback is injected into the game process without
  editing the author's `libs.js`.
- [EasyRPG](runtimes/EASYRPG.md) reads RPG Maker 2000/2003 assets from the original
  project, with private configuration, logs and saves. Existing portable saves
  seed its save folder once.
- [ScummVM](runtimes/SCUMMVM.md) reads original game data, using a private
  configuration, save directory and log. Its optional resource tools write
  separate exports.
- [FAVORITE/FVP](runtimes/FVP.md) links original scenarios and resource files
  into a private game view. RFVP writes saves, logs and preparation files under
  the game's module directory. An explicit save folder must be outside the
  original game folder; optional asset exports use separate private output.
- [WOLF RPG Editor](runtimes/WOLFRPG.md) prepares a compatible archive and browser
  player files under the game's module directory. Native save storage keeps
  browser saves available across local-server address changes.
- [CrossOver](runtimes/CROSSOVER.md) keeps registered applications in place.
  Bottles and a persistent writable game copy live under the game's runtime
  directory in MacLauncher storage. Filesystem cloning reduces copying where
  available; otherwise the private copy uses additional storage. Source updates
  replace unchanged private files while preserving private saves and mod edits.
- ZIP payloads, appended executable archives, ASAR and similar containers are
  extracted only when the selected runtime cannot read the packaged content
  directly. That extracted content stays in the game's private launcher data.
- Explicit decompilation or Mac application exports may create separate output
  because their purpose is to produce extracted source or a distributable app.

Inno Setup offline installers use the included
[innoextract](https://github.com/dscharrer/innoextract) reader. Add the installer
with its numbered data parts beside it. The backend lists the required parts,
unpacks once into `games/<gameId>/containers/inno/`, then detects the extracted
game through the ordinary engine registry. It never runs Windows installer code.
A compact progress row allows cancellation; incomplete output is removed.
Unchanged sources reuse the cache, including a retry after an unsupported-engine
result. Missing parts identify the exact filenames.

Ren'Py synchronization compares source file metadata and reuses unchanged
private inputs. It preserves the original source/compiled timestamps and
keeps generated caches between launches. The former full `game/` directory
alias is replaced automatically, so SDK compilation and local saves do not
write into the original game. Failed asset links do not silently fall back to
copying the entire game.

**Forget** removes a game's private launcher data, including extracted
containers and runtime wrappers, while preserving original files. **Move to
Trash** also moves the original game files to the Trash. Stop active games or
wait for their current actions to finish before removal. Cleanup runs separately
for each game, keeping other games and the launcher responsive.

Installer caches identify the source bytes and the reader's extraction format,
version and executable checksums. An existing game's cache remains reusable
when bytes match despite changed filesystem identifiers. Unchanged file
metadata takes a quick cache path; changed metadata requires checksum
verification before reuse. Compatible older caches migrate in place only when
their contents can be validated. Changed legacy caches without trusted byte
identities report an error instead of silently duplicating or accepting their
contents. Separate library entries keep separate game data.

Paths, case collisions, output sizes and regular-file types are checked before
publishing a completed generation. Read-only inspection can use an existing
cache; it does not extract or migrate an installer.

The completed installer generation is immutable module input. Runtimes keep
saves, configuration, logs and generated files in their own per-game directories.
A module that needs to patch scripts from a container must provide a small owned
overlay for those files; changing the extracted generation breaks its integrity
manifest. No complete game copy is needed for such an overlay.

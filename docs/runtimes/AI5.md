# AI5WIN / AI5-SDL2

Import accepts an original Windows game folder, its EXE or its AI5 INI. The selected native interpreter downloads after consent and runs from managed runtime storage. Original archives, images, audio and executables stay in place. Preparation writes a small configuration file and keeps saves/screenshots under Launcher Data.

The adapter uses [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2). It runs original-edition AI5WIN games with native menus, dialogue, audio and saves. Runtime Settings defaults to **Automatic**, which selects the edition from the game's original configuration. An explicit profile override remains available.

## Detection and versions

The shared offline detector gates this module on `AI5ENG.INI`, `AI5WIN.INI`, `syuusaku.ini` or `aiwin.ini`. It reads at most 64 KiB per INI, handles UTF-8, UTF-16LE and Shift-JIS, merges an existing `AI5SDL2.INI`, and preserves native assignment order for repeated fields and archive aliases. Declared files resolve within the original game with unambiguous case matching. Old Windows drive prefixes may resolve to an existing local basename; traversal, UNC references and escaping symlinks fail.

AI5 labels require coherent configuration and a validated script index containing the requested `STARTMES`. Index inspection follows pinned libai5's ordinary ARC XOR variants, DAT XOR and profile-specific shuffled indexes. Every entry is checked in bounded chunks; only a small name sample and the start-script entry are retained. Detection neither decompresses game payloads nor executes an EXE. Loose scripts have no identifying magic, so they additionally require an independently identified original AI5WIN runner.

The shared PE reader inspects only the bounded `RT_VERSION` resource branch. Original file/product versions stay distinct from the selected interpreter. A fixed file version becomes an **engine version** only when `ProductName` or `FileDescription` explicitly identifies AI5/AI5WIN/AIWIN. Marketing versions and a zero fixed version do not become guessed engine versions. Archive type and game profile remain separate facts.

## Native packages

MacLauncher Builds publishes Mac packages built from [AI5-SDL2](https://github.com/nunuhara/ai5-sdl2) with libai5 and nulib, libsndfile audio and FFmpeg movie playback. Each package contains the interpreter, its complete native dependency closure, fonts and license notices; Runtimes lists its architectures and minimum macOS. The Mac packages add recognition of the Japanese YU-NO voice-patch title, direct original-data and disc-image reading, and separate save storage.

**Runtimes → AI5WIN** discovers Mac packages through the MacLauncher Builds catalog on explicit Refresh or consented Play. Installed versions keep their exact identities and per-game selections. Upstream source releases are listed separately as source references.

Play installs the selected package after download consent. Installed packages work offline without a compiler, Homebrew, Wine or Windows fonts. Runtime storage is `~/Library/Application Support/maclauncher/runtimes/ai5/<version>/`. Source, patches and build recipes are in the MacLauncher Builds repository.

## Original assets and private state

The native process runs in the original directory and reads archives and loose assets directly. One private UTF-8 INI normalizes authored Windows references; native configuration parsing receives its absolute path. Portable font paths replace the build-machine prefix. The original configuration and assets remain unchanged.

Interpreters with original-disc resource support also read original ISO9660 and MODE1/2352 disc images directly; a disc layout with an interpreter lacking that support reports the requirement before launch. This expensive check is gated behind a positively identified AI5 game and runs on Play. Disc INIs must declare the same native profile; multiple matching disc directories are rejected as ambiguous. Metadata follows [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/) with bounded volume/directory reads, paired endian checks, extent validation and cycle limits. The reader accepts single-extent, non-interleaved records in those disc formats.

English translation layouts can retain base graphics/music inside an original disc image. Automatic preparation creates small range descriptors under `modules/ai5/disc/`; a native `funopen` stream reads those ranges across raw sectors without copying the archives or a game directory. Translation archives take precedence and missing members fall back to validated base archives. Nested voice containers resolve read-only. Missing mutable save slots can be seeded from disc defaults; original portable saves and existing private saves take precedence.

Save operations use `~/Library/Application Support/maclauncher/games/<game-id>/modules/ai5/saves/`, or an explicit save-directory override. First access to a slot can seed an existing portable original save through a bounded read-only handle. Existing private saves always win later. Screenshots and debugger image exports use the adjacent private `screenshots/` directory. Missing private roots fail closed instead of writing beside original assets.

Runtime Settings offers actual text-hook modes (Off, Console or Clipboard) and an optional font. The chosen capture mode overrides an old companion INI. The inspector provides access to the game’s save directory.

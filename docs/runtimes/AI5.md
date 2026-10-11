# AI5WIN / AI5-SDL2

Import the original Windows game folder, its EXE or its AI5 INI, then Play. The pinned native interpreter runs directly from read-only app resources without an installation copy. Original archives, images, audio and executables stay in place. Internal preparation writes a small configuration file and keeps saves/screenshots under Launcher Data.

The adapter uses [AI5-SDL2 1.5.0](https://github.com/nunuhara/ai5-sdl2/tree/1dfe835ceff2ecd62aa75ced91f11450dd75d1d2). Compatibility is limited to the original-edition profiles implemented by that pinned interpreter; other editions and elf engines are outside its scope. Runtime Settings defaults to **Automatic**, represented by the explicit `auto` value, so normalization retains the original configuration's detected edition. An explicit profile override remains available. Detection does not establish gameplay compatibility.

## Detection and versions

The shared offline detector gates this module on `AI5ENG.INI`, `AI5WIN.INI`, `syuusaku.ini` or `aiwin.ini`. It reads at most 64 KiB per INI, handles UTF-8, UTF-16LE and Shift-JIS, merges an existing `AI5SDL2.INI`, and preserves native assignment order for repeated fields and archive aliases. Declared files resolve within the original game with unambiguous case matching. Old Windows drive prefixes may resolve to an existing local basename; traversal, UNC references and escaping symlinks fail.

AI5 labels require coherent configuration and a validated script index containing the requested `STARTMES`. Index inspection follows pinned libai5's ordinary ARC XOR variants, DAT XOR and profile-specific shuffled indexes. Every entry is checked in bounded chunks; only a small name sample and the start-script entry are retained. Detection neither decompresses game payloads nor executes an EXE. Loose scripts have no identifying magic, so they additionally require an independently identified original AI5WIN runner.

The shared PE reader inspects only the bounded `RT_VERSION` resource branch. Original file/product versions stay distinct from the selected interpreter. A fixed file version becomes an **engine version** only when `ProductName` or `FileDescription` explicitly identifies AI5/AI5WIN/AIWIN. Marketing versions and a zero fixed version do not become guessed engine versions. Archive type and game profile remain separate facts.

## Native installation

| Component | Exact identity |
| --- | --- |
| Recommended native profile | `1.5.0-macos-v3`, upstream stable `1.5.0` |
| Retained direct-data profile | `1.5.0-macos-v1`, without the original-disc adapter |
| AI5-SDL2 source | `1dfe835ceff2ecd62aa75ced91f11450dd75d1d2` |
| libai5 source | `9b490c3d311ff9f8c61a9ccca9a5fd419bfd926a` |
| nulib source | `e007d00c8ca8cca402c64e99e8deb1259fadb1a3` |
| Audio / movie build | libsndfile / explicitly enabled FFmpeg |
| Package architecture | ARM64; Intel unavailable |
| Actual package minimum | macOS **13.0**, including the complete native dependency closure |

The shared catalog retains real stable releases 1.0.0–1.5.0 and their exact revisions. Explicit Reload uses paginated GitHub discovery shared with other engines. Stable 1.5.0 maps to the recommended Mac v3 profile. Earlier Mac v1/v2 installations retain explicit version identities and their own requirements. Historical source releases remain visible without a Mac/private-save adapter. Nightly tags do not become fabricated versions.

Release apps execute the sealed Included package directly from their resources. It contains the interpreter, relocated/signed dependency closure, fonts and license notices. Launch checks the selected version, source pin and complete payload integrity. Existing owned installations under `~/Library/Application Support/maclauncher/runtimes/ai5/<version>/` retain their exact identities. Normal play needs no compiler, Homebrew, Wine, Windows fonts or source checkout. Mac v3 uses separately pinned SDL2/font, libsndfile/audio and FFmpeg 7.1.2 source profiles targeting macOS 13. Its complete corresponding-source archive and offline build instructions accompany the release separately from the app.

## Original assets and private state

The native process runs in the original directory and reads archives and loose assets directly. One private UTF-8 INI normalizes authored Windows references; native configuration parsing receives its absolute path. Portable font paths replace the build-machine prefix. The original configuration and assets remain unchanged.

Mac v2 and later additionally read original ISO9660 and MODE1/2352 disc images directly. This expensive check is gated behind a positively identified AI5 game and runs on Play. Disc INIs must declare the same native profile; multiple matching disc directories are rejected as ambiguous. Metadata follows [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/) with bounded volume/directory reads, paired endian checks, extent validation and cycle limits. Multi-extent, interleaved and unsupported disc formats are rejected.

English translation layouts can retain base graphics/music inside an original disc image. Automatic preparation creates small range descriptors under `modules/ai5/disc/`; a native `funopen` stream reads those ranges across raw sectors without copying the archives or a game directory. Translation archives take precedence and missing members fall back to validated base archives. Nested voice containers resolve read-only. Missing mutable save slots can be seeded from disc defaults; original portable saves and existing private saves take precedence. Play automatically selects the current disc-capable profile when v1 is the global default; explicit per-game versions remain authoritative and incompatible choices report their capability limit.

Save operations use `~/Library/Application Support/maclauncher/games/<game-id>/modules/ai5/saves/`, or an explicit save-directory override. First access to a slot can seed an existing portable original save through a bounded read-only handle. Existing private saves always win later. Screenshots and debugger image exports use the adjacent private `screenshots/` directory. Missing private roots fail closed instead of writing beside original assets.

The module-owned native overlay also fixes two upstream loose-file failures: release debugger metadata passed a missing extension to `strcasecmp`, and synthetic loose image records discarded the extension needed by the decoder. The requested filename shares its record's allocation and normal release ownership. Vendored source is never edited.

Runtime Settings offers actual text-hook modes (Off, Console or Clipboard) and an optional font. The chosen capture mode overrides an old companion INI. Inspector save access is available; structured save editing, archive decompilation and launcher cheats are not claimed.

## Source build

Source Build is a development fallback. Initialize `src/external/ai5-sdl2` recursively at the listed pins. Prerequisites are Apple's Command Line Tools (`xcode-select --install`) and `brew install meson ninja pkg-config sdl2 sdl2_ttf libpng libsndfile ffmpeg` from [Homebrew](https://brew.sh/). Tools belong in `/opt/homebrew/bin` on Apple Silicon or `/usr/local/bin` on Intel. The builder never installs tools implicitly. It stages tracked source in owned runtime data, applies exact overlays there, disables dependency downloads, records source-tree/overlay hashes and configure options, and checks the external checkout before and after compilation.

Native menu/dialogue input and PCM decoding are available for compatible original-edition profiles. Complete gameplay, audio-device output and durable save/reload compatibility remain edition-specific.

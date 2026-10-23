# Nitroplus NPA/NSS native interpreter

The `nitroplus` module detects original Nitroplus directories and Windows
executables through a complete bounded NPA v1 script index and the declared NSS
boot script. The native player runs **unencrypted NPA v1 / NSS source** games.
Compressed script/image members can be read; compressed audio/movie archives are
gated because this streaming profile requires direct ranges in those payloads.

## Source and runtime identity

- Runtime manager: `npengine`; recommended runtime: **`0.5.3-macos-v8`**, Apple Silicon,
  macOS 13.0 or later. Existing explicit Mac v1–v7 installations remain separate
  and selectable.
- [libnpengine](https://github.com/FGRE/libnpengine/commit/da1a175e6b497c37f9714b77510cb47c0930cd42):
  `da1a175e6b497c37f9714b77510cb47c0930cd42`, LGPL-3.0-or-later.
- [libnpa](https://github.com/FGRE/libnpa/commit/5bdf666155d828d9ef4003fd9dc39e154aa4b0f1):
  `5bdf666155d828d9ef4003fd9dc39e154aa4b0f1`, MIT.
- Both live in read-only `src/external/` Git submodules. Builds stage their tracked
  files and apply the module's CMake/Clang/macOS/compiler/filesystem adaptations
  under the global runtime directory. Source and overlay hashes and configure
  options are recorded in the runtime installation.
- Mac v8 records `macos-npa-nss-private-v8`, source-tree and overlay digests in its
  native profile. Compiler file/debug/macro paths use logical source/build roots;
  published provenance contains logical source/build identities.
- The offline catalog contains pinned upstream source tags plus the Mac
  profile. Explicit Refresh uses the shared paginated GitHub tag provider;
  startup, detection and launch make no network requests.

The runtime is an arm64 Mach-O host and a dynamically linked libnpengine library,
with SDL2/OpenGL graphics, Pango text and GStreamer audio/movie decoding. The
module-owned archive reader reads NPA directories and requested payload ranges
directly from original archives. It avoids upstream's whole-archive header read
and honors GStreamer's allocator when streaming audio.
Original `system.ini` supplies window metrics, initial channel volumes and font
settings. The module's font configuration finds macOS system fonts and stores its
cache in private game data, without a Windows font installation.

## Original data and tools

Normal launch needs no game extraction. The launch manifest references original
archives directly. The runner writes saves, configuration outputs
and its GStreamer registry below
`userData/games/<gameId>/modules/nitroplus/`. Bundled runtimes and plugins execute
directly from read-only application resources; downloaded or locally built
versions live under `userData/runtimes/npengine/<version>/`. Filesystem writes and deletions
reject paths outside the private save directory and refuse symlink traversal.
Cmd-Q closes the native game window.

The inspector records these independent identities:

- NPA archive format version and compression/encryption flags;
- authored NSS `#SCRIPT_VERSION`, with its archive/member/assignment source;
- authored product version from `system.ini`, including its source;
- the original executable's bounded `RT_VERSION` file/product values.

A game's product or script version is not reported as a known version of the
original proprietary engine. Unknown engine versions remain unknown.

Advanced actions inspect indices/version metadata, extract NSS source as UTF-8
into private game data, check the actual native NSS compiler without a GUI, check
the selected runtime, and register a local complete native distribution. Explicit
extraction bounds individual scripts and total output and preserves the originals.
Save editing and cheats are unavailable.

The collapsed Advanced tools include **Log**, which reads bounded native output
from the last launch and its actual error detail. Logs stay in private game data;
ordinary quit and Inspector Stop do not create a runtime error. Unexpected native
termination uses the launcher's existing failure notification.

## Build and distribution

Play downloads a missing runtime from MacLauncher Builds after consent and continues automatically. Installed versions work offline; no compiler or Homebrew is needed. **Runtimes → Nitroplus** manages versions. Its complete package contains native libraries,
GStreamer plugins, profile/font configuration and license notices. Mac v8 targets
macOS 13.0 throughout its ARM dependency closure. Earlier profiles retain their
own dependency requirements.

The matching MacLauncher Builds release commit contains both pinned Git sources,
module adaptations, dependency definitions, notices and the build entry.
It rebuilds the engine, wrapper and module-built dependencies against the pinned
official GStreamer 1.28.7 development SDK. The SDK's corresponding sources,
Cerbero recipes, configuration and patches are included; the wrapper build does
not itself rebuild that SDK. Source and binary identities remain explicit in the
archive and sealed native manifest. [runtime distribution](RUNTIME_DISTRIBUTION.md) contains the corresponding reference.

Developer builds use [portable-build.js](../../src/modules/nitroplus/runtime/portable-build.js)
and [portable-media.json](../../src/modules/nitroplus/runtime/portable-media.json).
Apple's Command Line Tools install into `/Library/Developer/CommandLineTools`
with `xcode-select --install`; CMake, Ninja, pkg-config, Flex and Bison can be
installed with `brew install cmake ninja pkg-config flex bison`. Build tools are
development prerequisites only. Source copies receive the recorded overlays;
the read-only upstream submodules remain unchanged.

## NSS scripts and native input

The source compiler overlay supports older NSS comparison/logical precedence, grouped expressions, variable division, hexadecimal integers/colors, bare namespaces, compound scalar assignments, legacy terminators, separate text blocks, literal-`@`/colonless case forms and expression array indices. It also accepts the older `else[ ... }` spelling specifically in an else clause. Its bytecode matches an ordinary brace-delimited else block; array brackets keep their expression meaning. Japanese choice handles undergo one CP932 conversion, so a `case` names the same object as `CreateChoice`. Original NSS bytes are retained. Unknown tokens and unterminated text blocks fail instead of allowing a partially read source to appear compiled.

JPEGs decode as opaque RGBA before decompression starts; Cairo text uses the proper color, alpha and pixel channels. The bounded NSS `PRE` parser preserves words, punctuation escapes and literal ampersands, recognizes empty initialization markers, click boundaries and named voice fields, and retains font/ruby metadata. Control names and markup are validated against that parser’s grammar.

Mac v6 also publishes the `PRE` box handle as `$SYSTEM_present_preprocess` before authored text helpers select their `LoadText` branch.

Native choice objects include the `MouseLeave` namespace used by authored menu callbacks. Missing object reads return no object, invalid writes fail with their namespace, and cyclic aliases have a bounded failure.

Mac v7 finds drawable children throughout `MouseUsual`, `MouseOver` and `MouseClick` state groups, including arbitrary names and nested groups. Hit testing, state visibility and keyboard focus use their actual bounds. `SetNextFocus` also accepts a child-texture handle and resolves its containing choice. Existing `img` children remain supported; traversal is bounded to 32 nested groups and 4096 objects.

The native player provides menus, preference choices, story text and input. Text uses upstream's top-left layout rather than authored box coordinates.

The NSS compiler accepts the syntax described above. Scripts with `cut`/`call_cut` subroutines, stray delimiters, nested legacy text syntax, sound-effect or marker controls remain rejected.

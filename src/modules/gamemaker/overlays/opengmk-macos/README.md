# OpenGMK macOS native overlay

The `ramen/` files add an AppKit platform backend to [ramen](https://github.com/viriuwu/ramen) **0.0.3**, pinned to
`ef715f65981f6c96f7f889258ff43b63cb472626`. They extend [OpenGMK](https://github.com/OpenGMK/OpenGMK)'s existing window
and event API; the vendored repository and Cargo cache stay unchanged.

`applyRamenOverlay({ sourceDir, destination })` verifies nine upstream source hashes,
copies that source into a new owned staging directory, and applies the platform files.
It narrows upstream X11-only `cfg(unix)` methods to Linux, adds macOS cursor dispatch,
and records the dependency revision, overlay version and source/overlay hashes in
`maclauncher-overlay.json`. The source identity is checked before copying.
Cargo uses the owned copy with a workspace patch:

```toml
[patch."https://github.com/viriuwu/ramen"]
ramen = { path = "../overlays/ramen" }
```

The Objective-C shim uses the built-in AppKit framework and the exactly pinned existing
[`cc`](https://github.com/rust-lang/cc-rs) build dependency **1.2.60**. It adds no SDL or UI-framework installation to the
game launch flow. Developers compiling the port need Rust and Apple's compiler under
`/Library/Developer/CommandLineTools`; macOS installs those compiler tools with
`xcode-select --install`. A distributed native runtime contains the compiled shim.

`Window::nsview()` and `Window::nswindow()` return borrowed native pointers for the
renderer. Native access is guarded to the process main thread. If a window is dropped
from another thread, native disposal is scheduled on the main queue. The view requests
one framebuffer pixel per AppKit point, preserving GM8's existing size and input
coordinates without adding unhandled Retina scaling to the renderer.

The backend supports window creation, titles, positioning, resizing, visibility,
decorations, zoom state, close requests, focus, physical keys and separate left/right
modifiers, Unicode and IME committed text, three mouse buttons, motion, enter/leave,
scroll, and available native cursors. App switching releases held keys/buttons to avoid
stuck controls. A bounded ring coalesces repeated geometry/motion and handles events in
constant time. macOS has no matching public busy cursor; wait/progress use its arrow,
and diagonal resize uses its crosshair. Native controls and Command–Q remain available.

The native runtime combines this layer with the selected GM8 parser, renderer
and engine APIs.

The upstream ramen license is Zlib; its copied license remains in the owned source.
These new files remain part of MacLauncher's owned overlay.

## Native emulator and extension ABI

`applyEmulatorOverlay` validates the pinned OpenGMK source hashes before any
mutation, then applies the owned renderer, platform, extension and file-path
integration to that copy. Overlay `maclauncher-appkit-gl-6` uses an AppKit
`NSOpenGLView`, an OpenGL 4.1 core context and the pinned [udon](https://github.com/Adamcake/udon)/CoreAudio output.
`applyAudioOverlay` selects Linux-only build flags by the actual Cargo target,
leaving the audio library's decoder/output source unchanged. The renderer accepts
Apple's available core profile without demanding hardware-only acceleration.

The view and context share the same core pixel format. Presentation temporarily
binds the window framebuffer while AppKit swaps, then restores the game's render
target. This also presents correctly on Apple's software renderer. Native
display-size, positioning, position-query and window-centering APIs use the
actual Mac display. AppKit constrains requested frames to keep title controls
available; ordinary play uses actual geometry separately from TAS spoofing.
The first room is centered after the runtime applies its creator-defined scale,
so a scaled launch cannot retain the smaller construction window's position.
Programmatic resizing preserves the current visual center and constrains the
native frame, including scaling requested from room-creation code. Explicit
position setters use the actual Mac coordinates.

The native executable supports `--version`, `--inspect-json` and
`--working-directory`. Inspection strictly parses original assets and inventories
embedded extension signatures and GML `external_define` calls without executing
GML, opening a window, loading DLLs or writing included files. Its JSON reports
actual compiled native ABI profiles; launcher preflight does not infer extension
necessity from adjacent DLL filenames.

The Mac extension dispatcher replaces Windows DLL loading with explicit native
implementations. The SuperSound profile implements its 22 string-ABI symbols with
WAV/Ogg decoding and real CoreAudio mixer state, including position, frequency,
volume/pan, loops and pause controls. Load hints use bounded resident PCM, including
the streaming hint. Symbol lookup and call types follow that profile’s ABI declarations. Normal
gameplay never uses the upstream dummy-effect/audio bypass or Wine helper.

`paths.rs` reads original resources in place while redirecting writes into a
separate private working directory. Append/read-write copies only the affected
original file. The native highscore table implements the four table/query APIs
with private persistence.
Bundled distribution records architecture, macOS floor, exact upstream/dependency
revisions, overlay hashes, Cargo lock hash, compiler options, binary hash and
license notices. Build flags remap private paths before compilation. The tagged
Builds repository contains the owned overlays, build recipes and pinned upstream
sources. Local corresponding-source archives retain checksum-validated
dependencies and `source-build.js`; that script builds owned source copies
offline. Pinned immutable
packages execute directly from the app's resources; users need no compiler,
source checkout or runtime copy.

## Native decompiler workspace

`decompiler-workspace.patch` applies only to a private source copy of OpenGMK
`9ccc47a9cab4681a889866f7233a6b016d36a15e`. It selects the `gm8decompiler`,
`gm8exe` and `gml-parser` crates, leaving the emulator out of the tool build,
and removes the inactive Windows `winres` build dependency from that Mac-only
workspace. Rust sources and `build.rs` remain the pinned upstream bytes.

Release builds validate retained crate archives against the upstream Cargo.lock
checksums before constructing an owned registry source view. Cargo runs offline
with the release profile. Workspace pruning may remove unused lock entries; every
retained package version/source/checksum must still match the original lock.
Rust remap flags and C file/debug/macro prefix maps remove local paths. The package
records `workspaceOverlaySha256` separately from native code overlays. This
profile builds the decompiler only and adds no Classic-game runtime.

The same public source recipe supports both targets:

```sh
node source-build.js SOURCE_PACKAGE NEW_BUILD_DIRECTORY gm8emulator
node source-build.js SOURCE_PACKAGE NEW_BUILD_DIRECTORY gm8decompiler
```

The input is an extracted corresponding-source archive containing `OpenGMK/`,
`Cargo.lock`, the checksummed `registry/`, and the emulator's pinned dependencies.
The optional target defaults to `gm8emulator`. The decompiler checks its three
upstream build-input hashes, applies the workspace patch to the owned copy and
supplies upstream's exact Git revision through an owned build-tool shim. Its
upstream Rust files stay unchanged. This avoids reporting the parent launcher's
revision when compiling a source archive without Git metadata.

The recipe sets an executable deployment target of macOS 13 for the emulator
and 11 for the decompiler; a release manifest must still record the actual floor
of every retained native dependency. Builds need the installed stable Rust
toolchain and Apple’s compiler. `NEW_BUILD_DIRECTORY` uses the Mac’s native
filesystem; original inputs can stay on a shared volume. Cargo runs with `--offline`; it does not install
either toolchain. Upstream’s decompiler embeds the current UTC build date in each
executable. The [runtime release reference](https://github.com/procrastinine/maclauncher-builds/blob/main/docs/RELEASES.md)
records the toolchain, options and sealed output bytes.

## Corresponding-source archive creation

Runtime releases attach the binary package. The release tag identifies the Builds
commit containing the owned source, patches and pinned upstream repositories.
Package `0.2.0-MCLv1` retains native overlay identity
`maclauncher-appkit-gl-6`.

[`source-archive.py`](source-archive.py) creates the archive with UID/GID zero,
empty owner/group names, sorted members and zero TAR/gzip timestamps. It
preserves existing source contents and permissions, includes its exact creation
recipe and refuses existing output paths.
[`SOURCE_ARCHIVE.md`](SOURCE_ARCHIVE.md) describes the command and archive
contract. Runtime catalog `sourceArtifact` fields retain the local source archive's
versioned filename, SHA-256 and byte length as provenance. Play uses only the executable and
notices.

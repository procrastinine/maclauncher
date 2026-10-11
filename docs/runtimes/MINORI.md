# Minori

[ReMinori](https://github.com/luoyily/ReMinori) provides native playback for
Minori PAZ formats on Apple Silicon. Import the complete Windows game folder,
executable or supported offline installer, then press **Play**. The Included
runtime runs directly, without installation, a compiler or manual options.

## Runtime and data formats

| Runtime | Source revision | CPU | Minimum macOS |
| --- | --- | --- | --- |
| `0.1.0-79b0099-macos-v2` | [`79b00990324404bfbd496e7fa76c690cf040f744`](https://github.com/luoyily/ReMinori/commit/79b00990324404bfbd496e7fa76c690cf040f744) | ARM64 | 13.0 |

The backend validates the PAZ archive set before launch. Profiles that use PE
key tables also read the original Windows executable. Supported data profiles
are:

| Profile | Key source |
| --- | --- |
| `paz-bf-slot0-rc4-v1` | Supported PAZ header and archive-key layout |
| `paz-pe-keytables-rc4-v1` | Supported key tables in the original Windows PE |

The Windows executable is read as data; it is never executed. Its file version
is shown separately from the archive format and native runtime version. Other
encryption layouts and VM editions are unsupported.

## Play, saves and scripts

The runtime supports title/menu interaction, story text and artwork,
keyboard input, AppKit game controls, save comments, thumbnails and save/load.
Saves use `games/<gameId>/modules/minori/saves/` below launcher data, or the
normal per-game save-folder override. Original PAZ and executable files stay
unchanged; caches and generated files remain in private game storage.

The inspector offers **Extract scripts**, **Show scripts**, **Remove scripts**
and **Verify archives**. Script exports are UTF-8 files in the game's launcher
data. Save editing and cheats are unavailable.

Movie and audio playback use a local [FFmpeg](https://ffmpeg.org/) 7.1.2 bridge
with the codecs and containers enabled by the included build. The bridge makes
no network requests.

## Source and licenses

The [owned source overlay](../../src/modules/minori/runtime/overlay.js),
[native builder](../../src/modules/minori/runtime/build.js) and
[movie builder](../../src/modules/minori/runtime/movie-build.js) preserve exact
source, dependency, option and CPU identities. Source builds require
[Rust](https://rust-lang.org/tools/install/) in `~/.cargo/bin/` and Apple's
compiler tools (`xcode-select --install`) in
`/Library/Developer/CommandLineTools/`, plus the pinned source and cached Cargo
dependencies. Included Play needs neither tool. See
[Native tool setup](NATIVE_TOOL_SETUP.md) for other source-build prerequisites.

ReMinori retains AGPL-3.0, the LGPL-configured FFmpeg libraries retain
LGPL-2.1-or-later, and Rust components retain their own notices. See
[attributions](../ATTRIBUTIONS.md) and [runtime distribution](RUNTIME_DISTRIBUTION.md).

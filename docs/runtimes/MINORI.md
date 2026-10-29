# Minori

[ReMinori](https://github.com/luoyily/ReMinori) provides native playback for
Minori PAZ formats. Import accepts the complete Windows game
folder, executable or matching offline installer. Play requests consent for a missing runtime, downloads it from MacLauncher Builds and continues without a compiler or manual options. Installed versions work offline. **Runtimes → Minori** manages versions.

## Runtime and data formats

MacLauncher Builds publishes native ReMinori packages. Each package records its source revision, dependencies, build options and CPU identities; Runtimes lists its architectures and minimum macOS.

The backend validates the PAZ archive set before launch. Profiles that use PE
key tables also read the original Windows executable. Supported data profiles
are:

| Profile | Key source |
| --- | --- |
| `paz-bf-slot0-rc4-v1` | Supported PAZ header and archive-key layout |
| `paz-pe-keytables-rc4-v1` | Supported key tables in the original Windows PE |

The Windows executable is read as data; it is never executed. Its file version
is shown separately from the archive format and native runtime version. Each
listed PAZ profile selects its corresponding archive and VM implementation.

## Play, saves and scripts

The runtime supports title/menu interaction, story text and artwork,
keyboard input, AppKit game controls, save comments, thumbnails and save/load.
Saves use `games/<gameId>/modules/minori/saves/` below launcher data, or the
normal per-game save-folder override. Original PAZ and executable files stay
unchanged; caches and generated files remain in private game storage.

The inspector offers **Extract scripts**, **Reveal scripts**, **Remove scripts**
and **Verify archives**. Script exports are UTF-8 files in the game's launcher
data. Save editing and cheats are unavailable.

Movie and audio playback use a local [FFmpeg](https://ffmpeg.org/) bridge
with the codecs and containers enabled by the selected runtime package. The bridge makes
no network requests.

## Source and licenses

The [owned source overlay](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/overlay.js),
[native builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/build.js) and
[movie builder](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/maclauncher/src/modules/minori/runtime/movie-build.js) in MacLauncher Builds preserve exact
source, dependency, option and CPU identities. Installed packages need no Rust or compiler tools.

ReMinori retains AGPL-3.0, the LGPL-configured FFmpeg libraries retain
LGPL-2.1-or-later, and Rust components retain their own notices. See
[attributions](../ATTRIBUTIONS.md) and [runtime distribution](RUNTIME_DISTRIBUTION.md).

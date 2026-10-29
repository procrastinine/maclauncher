# Video

MacLauncher plays local videos through managed mpv, with the same shaders,
scaling, neural reconstruction and ordered effect chains as games. Import
accepts MP4, M4V, QuickTime, Matroska, WebM, AVI, FLV, MPEG program streams and
Ogg Theora. It reads local container and video-track metadata without starting
a player or connecting to the network.

A folder containing top-level videos and no top-level executable imports as one
playlist after game detection. Videos sort alphabetically by filename; nested
videos are excluded. The inspector's **Video** menu selects a starting video or
**Automatic**, which resumes the last unfinished video or starts the next after
completion. Finishing the final video returns Automatic to the first video.
Playback continues through the remaining playlist, with previous/next controls
available in mpv. Watch positions are stored in the library's per-entry data.

Embedded subtitles and matching sidecar subtitles register automatically.
Sidecars can sit beside the video or in `subs`, `subtitles`, `Subs` and
`Subtitles` folders; filenames can include language suffixes, such as
`Episode 01.en.srt`. Subtitle selection remains in the player.

Play offers a missing mpv download, installs the chosen version and starts
playback. Installed versions work offline. **Runtimes → mpv player** provides Builds and Upstream sources, Refresh,
Install, local import and removal. Upstream Refresh includes numbered releases and
development builds from [git-release](https://github.com/mpv-player/mpv/releases/tag/git-release).
Development versions retain their exact source commit and build identifier;
an installed version stays fixed when the development release updates.
The catalog's Apple Silicon mpv 0.41.0 build runs on macOS
14 or later; downloads verify their archive and native dependencies. The
decoded GPU profiles require Apple Silicon and macOS 27 or later;
the original CLI profile retains its own lower deployment target.

mpv retains its seeking, pause, volume, resizing and fullscreen controls. The
initial window fits within 80% of the screen without locking its size. Local
playback uses the selected mpv configuration and plugins, with embedded file
references and network media resolution disabled by default. Custom launch arguments are passed
literally before the video-file argument and apply to the next playback.

## Player configuration and plugins

**Settings → Video**, under the mpv player heading, provides playback defaults; each video's mpv settings
can override them. **uosc controls** and **Timeline previews** are enabled by
default. [uosc](https://github.com/tomasklaen/uosc) provides the timeline and
playback controls; [thumbfast](https://github.com/po5/thumbfast) generates preview
images while hovering over that timeline. Plugins install only through explicit
Install, Download or Update actions. Missing plugins never block Play or request
a required download; playback uses mpv's standard controls. Installed plugins
remain available offline. Upstream mpv and decoded GPU profiles load the same
player configuration, scripts and plugin settings. With uosc disabled, mpv's
standard on-screen controls remain available. Decoded GPU playback uses a
separate managed mpv command-line player for thumbfast's image-encoding worker;
previews remain off when no compatible worker is installed.

**Runtimes → mpv player → Plugins** places each plugin's enable switch, installation
status, Install or Repair action, removal and source link together.
Missing or damaged installations disable their enable switches until installation
or repair completes. Successful removal disables the plugin; canceled removal
preserves the setting.

**Add plugin** accepts a GitHub repository or file link, a Lua/JavaScript script
or ZIP URL, or a local script, ZIP or plugin folder. **Script location** selects
an optional relative entry path for packages with a different layout. Added
plugins appear beside uosc and thumbfast with enable and removal controls.
Managed copies preserve the original local files and remain available offline.
Adding an updated source creates a separate version identified by its content.
GitHub repository imports retain the resolved commit. Downloads run through
explicit Download or Update actions; local import, status and playback remain offline.

**Refresh** discovers current uosc and thumbfast revisions and displays available
updates. **Update** checks and installs from a plugin's saved source. uosc follows the
latest stable release, including its configuration and license; thumbfast follows
the current upstream commit. thumbfast versions are labelled by their commit date,
such as **2026-06-28 snapshot**; the exact commit remains the version's identity. Other plugins retain their original URL, branch or
local path and optional entry script. An explicit commit or release URL keeps
that version fixed. An unchanged source reports **Up to date**. Failed updates
preserve the installed copy and settings, and disabled plugins stay disabled.
Earlier copies remain available offline; enabling an earlier copy selects it in
place of another version from the same source. Updates apply on the next Play.

**Configuration and scripts** expands the local file and folder controls.

**Configuration folder** points to an existing mpv configuration directory with
`mpv.conf`, `input.conf`, `scripts`, `script-opts`, fonts and other mpv resources.
**Additional configuration files** load further files in the listed order.
**Additional scripts** loads Lua or JavaScript files and mpv script folders.
**Input configuration** selects a separate file for keyboard and mouse bindings.
Browse and Add controls select local files and folders; typed lists use one
absolute path per line. Selected files remain in their original locations.
Configuration and plugin changes apply on the next playback. The
[mpv manual](https://mpv.io/manual/stable/#files) describes configuration entries,
script options and resource paths.

## Filters and effects

New videos use **Lanczos · Sharp** scaling. The graphics chain has independent
Downsample and Upscale stages, with filter and output-size controls. Turning
Graphics off preserves the chain and uses basic bilinear resizing. The native
filter list comes from the installed player and updates during playback through
its live connection; the player version and decoder stay fixed for that session.
Decoded GPU builds render at decoder dimensions into IOSurfaces shared with
Metal. The common graphics graph receives those textures before window fitting;
image filters, downsampling, neural reconstruction, upscaling and interpolation
retain their saved order. Pixel processing stays on the GPU. Paused redraws
retain decoded content identity and do not submit interpolation history.

Decoded GPU profiles with separate overlay support render mpv's controls,
subtitles and plugin overlays at the window's backing resolution. A transparent
native layer presents them after the video effect chain. ASS output from uosc,
bitmap previews from thumbfast and other mpv overlays retain their original
colors and sharpness independently of video resolution and effects.

Original mpv CLI builds retain their native output path. Shared effects receive
the composed RGB drawable through native Metal or OpenGL hooks after mpv's
output scaling. The runtime's Source detail identifies the actual route; a
window graphics host does not itself enable ScreenCaptureKit streaming.
The [frame-source reference](../GRAPHICS_PIPELINE.md#frame-sources-and-scene-inputs)
describes source routes and separate scene inputs.

MPV/libplacebo shaders can use source, luma, chroma and scaling phases in mpv's
native pipeline. A compatible shader prefix runs there with original decoder
planes. Later luma/chroma shaders retain their position in the shared chain and
use GPU-derived planes when supported by the selected graphics runtime. Native
decoder metadata remains specific to the original prefix. Native filters run
once, independently of shared ReShade, Slang, neural and scaling stages.

Shader selection, parameters, order and shared effects update during playback.
Replacement resources prepare before switching; rejected edits keep the current
chain. Updates preserve playback position, pause state, window and fullscreen.
Shared-only changes redraw a paused image without seeking. Combined native and
shared changes use a coordinated display hold; transitions outside that hold's
presentation mode can be applied separately or on the next playback. Graphics
bypass preserves saved effects; clearing the chain is a separate action.

**Manage filters…** opens the existing Runtimes → Graphics shader library. Local and managed
shaders use the same selectors. Original files stay in place; prepared revisions
pick up source edits without reusing old compiled contents.

Shared neural reconstruction consumes the supplied RGB image. Its
model and processing stages remain independent of native decoder filtering.
Downsample, intrinsic model scale and Upscale retain their own dimensions.
The [graphics guide](../GRAPHICS.md) covers models, shader parameters,
chain ordering and processing sizes.

## Preview and export

**Tools → Video processing** provides **Inspect media**, **Preview settings** and
**Export video…**. Preview and export use the saved graphics chain, including
applied presets.

For playlists, inspection and export use the video selected by the inspector's
Video menu, including Automatic's current choice. Preview opens the playlist.

**Inspect media** writes container, duration, stream/codec, chapter and tag
metadata to `modules/video/inspection/media.json`. It reuses the selected managed
mpv with an explicit private script and null audio/video outputs. User mpv
configuration, automatic scripts, network references and download integrations
are disabled. The media file remains unchanged.

**Preview settings** plays the video through mpv with its native shader phases,
shared effects and ordinary playback controls.

**Export video…** renders image filters, resizing and compatible neural stages into a
separate MP4 file. A size dialog offers Original, 2× and 4K before the save dialog;
an enabled upscale stage initially selects 2×. Output dimensions determine automatic
fitting and window-relative row sizes. Relative factors, fixed sizes and stage
order retain their meaning independently of the playback window.

Export runs on macOS 14 or later with AVFoundation-decodable opaque sources
containing one video track. SDR uses H.264; tagged PQ and HLG sources use float
GPU processing and hardware HEVC Main10 encoding with their output color tags.
MP4 retains AAC audio, source timestamps, rotation and mirror metadata.
The source and existing outputs remain unchanged. Progress includes Cancel, and
completion provides **Reveal in Finder**.

ReShadeFX, Slang, mpv/libplacebo, Downsample, Upscale and neural rows retain their
saved order. Export starts with decoded RGB and uses the derived-plane adapter
for luma/chroma hooks. Native decoder-only inputs require the mpv prefix. Scene
Temporal upscaling requires renderer guides that the export decoder does not supply.
Frame-generation export requires an offline runtime advertising paired-frame
output for the selected method. Compatible image-pair methods insert generated
frames between source timestamps. Warmup and unavailable phases hold a completed
real image; held frames are counted separately from generated frames. Source
videos with alpha use Preview.

Neural export uses the selected model, intensity and temporal reconstruction
option. **Runtimes → Graphics → Neural models** manages packages; model choosers
also import local apps or ZIPs. The optional consented DLSSMac model download
imports only packages and notices, without executing its app. Model weights
retain their original terms.

mpv is distributed separately. Its
[installation reference](https://mpv.io/installation/) and
[release catalog](https://github.com/mpv-player/mpv/releases) describe upstream
builds and licenses.

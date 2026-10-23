# Video

Local video files use managed mpv playback. Import accepts MP4, M4V, QuickTime,
Matroska, WebM, AVI, FLV, MPEG program streams and Ogg Theora with matching
container and video-track metadata. Audio-only files and folders of media assets
are excluded. Import reads bounded metadata without starting a player or making
network requests.

Play obtains consent for a missing mpv download, installs the selected version
and starts playback. Installed versions work offline. **Runtimes → mpv** provides
explicit version refreshes, installation and removal. The included catalog entry
uses the mpv project's Apple Silicon macOS 14 build of version 0.41.0; its archive
checksum and native dependency requirements are checked during installation.
Newer downloads retain their declared macOS requirements.

Launch arguments are passed literally to mpv before the video-file argument.
Changes take effect on the next playback.

New videos select **Lanczos · Sharp** in the Simple spatial selector. Native
filter choices configure mpv's luma, chroma and downscaling against decoded
frames. Nearest neighbour, bilinear, bicubic and the installed player's
additional filters use that original renderer; shared methods retain their
separate graphics processing. An explicit Off choice uses basic bilinear
resizing. Existing video settings and game defaults remain unchanged; game
upscaling starts off.

The initial aspect-preserving window fits within 80% of the screen.
Video playback also uses the shared window graphics adapter, with the same
shader and Advanced effect controls as game windows. mpv uses its local controls
for seeking, pause, volume and fullscreen. By default, local playback disables user configuration,
automatic script loading, embedded file references and the network media
resolver. GPU effect support follows the active renderer and provider
requirements.
The initial fit does not lock the window size. Native resizing and fullscreen
remain available without changing the macOS display mode.

The filter list comes from the selected mpv installation. Installation records
its native scaler registry when available; the pinned 0.41.0 catalog entry has
an archive-specific fallback. Other installations without registry metadata
retain the basic standard filters. Status reads and playback selection use
local metadata without starting a player process or checking the network.
Native filter changes update the running player's luma, chroma and downscaling
controls through its live connection. Source render-resolution controls are
omitted because the player retains the video's decoded dimensions. The selected
player version and decoder remain bound until playback closes.
If the local live-control connection cannot be prepared, playback continues
with its launch settings. Native filter edits then take effect on the next
playback.

Compatible MPV/libplacebo hooks run in mpv's native video pipeline, where their
declared source, luma, chroma and scaling phases are available. In Advanced, an
initial sequence of compatible shader rows runs there before shared processing.
Later RGB shader rows retain their position in the shared graphics chain. A
video-plane row must precede shared RGB processing. Playback skips an unavailable
shader or incompatible video-plane row, reports its reason in the runtime log
and retains other compatible effects. The saved selection remains unchanged.
Edits during playback remain transactional: an invalid selection retains the
previous accepted pipeline.
Original shader files remain at their selected local or managed locations.
Native playback uses immutable prepared revisions, so editing a source file
can select a fresh revision without the player reusing its cached old contents.
Compatible native shader selections, parameters and prefix order update during
playback, alongside supported shared RGB controls. Shared resources are prepared
before the player changes its native options. A rejected edit retains the
previous settings; updates preserve playback position and the existing pause
state, window and fullscreen mode. Cancelling an update interrupts pending
player requests; recovery retains its connection to restore options already
sent. Accepted shared-only changes request a video
redraw after publication, including while paused, without seeking or changing
the pause state or existing on-screen messages. Unchanged settings do not request
a redraw. Changes that update both native and shared processing together require
a compatible display hold. The version-one hold
retains an existing visible opaque SDR overlay through validation and recovery,
and supports changes that continue using that presentation. With failed-presentation recovery
support, a terminal GPU error returns to original rendering only after the
previous shared settings, native options and pause state have been restored;
that release does not claim a completed processed frame. Other combined
transitions retain their previous settings; the controls can be applied
independently or used on the next playback. Native Simple filters are
excluded from shared spatial processing to avoid applying them twice. Advanced
custom sizes, downsample and neural rows retain their position in the shared
chain. Saving an Advanced chain keeps its full shader sequence. Native shader
rows are separated from shared RGB
processing during preparation, while the saved chain retains their order and
settings.
Returning from an unedited Advanced preview preserves the Simple selections.
Resetting an edited Advanced chain to Simple clears that chain and updates native hooks
and filters to the Simple selections. Sessions started without a compatible
live connection retain their previous native bindings until the next launch;
new preferences are saved without publishing a partial shared chain.

**Manage effects…** opens Settings → Graphics → Shaders and filters for local
registrations. **Download shaders…** there opens the managed Shader library in
Runtimes. Native video-plane shaders appear for this renderer; game selectors
retain only compatible RGB choices. Shader files may be selected from local or
managed storage. Missing sources remain unavailable.

Simple **Neural reconstruction** is optional and starts without an automatic
processing reduction for video. Its selected model, intensity and temporal option use the
shared processor; native shader prefixes retain their original mpv phases.
Native video defaults to processing scale 1. An explicitly selected Auto scale
uses the current presentation extent; existing numeric scales remain explicit.

## Preview and export

**Tools → Video processing** provides **Preview settings** and **Export video…**
together. Both use the video's saved Simple settings or Advanced chain, including
an applied Advanced preset. Graphics controls and presets remain in the same
inspector and Settings panels.

**Preview settings** starts the ordinary mpv playback flow with those settings.
It retains the player's seeking, pause, resizing and fullscreen controls. Native
video shader phases remain available through mpv; shared RGB effects follow
their usual renderer and provider requirements.

**Export video…** renders compatible RGB shader, spatial-scaling and MLX-DLSS
stages into a separate MP4 file. A native size dialog offers Original, 2×, 4K
and Cancel before the save dialog; Simple upscaling starts with 2× selected.
The chosen file dimensions provide the presentation extent for automatic fitting
and window-relative stage targets. Advanced factors, fixed pixel sizes and
stage order retain their meaning inside that extent. The playback window does
not determine export dimensions.

Export requires macOS 14 or later and an opaque SDR source with one video track that
AVFoundation can decode. Playback follows mpv's broader format support; an
importable or playable video is not necessarily exportable by AVFoundation.
Sources with a declared alpha channel use **Preview settings**; H.264 export
does not preserve transparency.
The exporter uses hardware-capable AVFoundation decoding and H.264 encoding
rather than recording a player window. Output is MP4 with source audio encoded
as AAC. Original presentation timestamps and rotation or mirror metadata are
preserved. The source remains unchanged, existing outputs are preserved,
and the action provides progress and Cancel. Encoding continues if progress
reporting becomes unavailable; Cancel stops processing. A completed output appears with
**Reveal in Finder** in the inspector. Selected stages and their input
requirements are validated before rendering; decoded color frames do not supply
game scene depth or engine motion vectors. Compatible ReShadeFX, Slang and RGB
mpv/libplacebo shader rows, spatial filters and MLX-DLSS rows retain their saved
order. Native luma/chroma-only hooks, renderer scene-temporal upscaling and frame
generation are rejected before encoding. **Preview settings** retains the
native playback route for video-plane hooks.

Neural export uses the model, intensity and temporal setting selected in Simple
or each Advanced neural row. The local library is managed in
**Runtimes → Graphics → Neural models**; model choosers also import compatible
local application or ZIP sources. An optional consented model download imports
compatible packages and notices from the pinned DLSSMac release without running
its application. Model weights are separate from MacLauncher and retain their
original terms. Export provider availability follows each selected component's
architecture and macOS requirements.

mpv is distributed separately from MacLauncher. Its
[installation reference](https://mpv.io/installation/) and
[release catalog](https://github.com/mpv-player/mpv/releases) describe upstream
builds and their licenses.

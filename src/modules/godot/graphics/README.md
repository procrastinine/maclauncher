# Godot graphics integration

MacLauncher's shared native temporal upscalers need each frame's depth, motion
and camera data, which must come from the game's renderer. For Godot 4.4 and
later 4.x releases, an included camera helper connects the engine to these
upscalers. The helper supports the Metal Forward+ renderer, finite perspective
cameras and single-view viewports, while Compatibility, Mobile, XR, orthographic
and custom oblique projections keep the engine's rendering path.

Games launched with an installed Godot runtime, and recognized native Godot app
bundles, receive the helper as an autoload only when the saved effect plan has
an enabled row that consumes scene inputs (`sceneDemand` in
`src/modules/shared/effects/scene-demand.js`) or requests a different source
size. Other launches run the original project or pack. With the helper loaded,
selecting a temporal method attaches a compositor effect to each eligible
viewport's active camera and selects Godot's MetalFX Temporal input path. The
shared graphics runtime then applies the selected MetalFX or FidelityFX
implementation, and the Temporal selection leaves the game's render scale
unchanged. Game default instead removes the camera effect and restores the
original compositor and viewport scaler. Existing game compositor effects and
later camera changes are preserved. While the helper is inactive, it reads only
the shared cached selection and adds no render callback or GPU work.

## Render source control

The helper can also change the size at which Godot renders its 3D scene, which
MacLauncher uses for **Game resolution**. For this, it sets Godot's root
viewport 3D render scale with Forward+ and Mobile rendering, independently of
the camera extension. This path requires an active 3D camera and a non-XR root
viewport. Compatibility rendering and child viewports keep their existing
scales, and the window, final drawable, GUI and input coordinates keep their
dimensions.

`RESHADE_RENDER_SOURCE_CONTROL=engine` enables this control, and three variables
set the size. `RESHADE_RENDER_HEIGHT` requests an exact height bounded by the
physical viewport output, `RESHADE_RENDER_MAX_HEIGHT` caps the existing render
height, and `RESHADE_RENDER_MULTIPLIER` accepts output divisors 1, 1.5, 2 and 3.
An exact height takes precedence over the cap, and the cap over the divisor.
Caps and divisors preserve an existing lower game scale. Because requested
scales follow the public Viewport range of 0.1 through 2.0, very small requested
heights may reach that lower limit.

To apply a size, the helper reads the root viewport texture extent and adjusts
only `Viewport.scaling_3d_scale`, following window and viewport changes. When
the game writes its own scale, that value becomes the baseline for later caps
and restoration. An inactive 3D view or removal of the helper restores the
baseline if the helper still owns the current value. Without explicit engine
control, no resolution processing runs.

The reduced 3D buffer is scaled back up by one of Godot's own viewport scaling
modes. For Simple bilinear, MetalFX or FSR 1 scaling with neural and temporal
rendering off, the helper selects the matching mode, which reconstructs the
reduced 3D buffer before full-resolution GUI composition; MetalFX requires
Godot's Metal driver. Advanced effect plans instead select an engine filter
explicitly with `RESHADE_RENDER_SOURCE_METHOD`, which takes precedence over the
Simple selection. Without an explicit engine filter, Advanced keeps the game's
viewport filter. Mode changes made by the game are preserved for later
restoration, and temporal camera integration takes precedence while it is active.

The provider's metadata advertises this script contract as
`sourceResolutionAPI: 1`, and its source adapter declares the bilinear, MetalFX
and FSR 1 methods. Older provider versions expose camera support without render
source controls. Versions with `sourceResolutionLiveAPI: 1` and the matching
recorded autoload hash also advertise `sourceResolution.live: true`, and while
the helper is loaded, a dormant control channel then allows changes during play.
The channel polls at 100 ms intervals without per-frame JSON parsing. A null
request leaves the game's scale and filter unchanged until the helper owns a
source override, and removing an override restores only the values that the
helper still owns.

Three environment variables set up this channel for one launch.
`RESHADE_RENDER_SOURCE_CONTROL_FILE` names the launch's atomic JSON command,
`RESHADE_RENDER_SOURCE_STATUS_FILE` names its result, and
`RESHADE_RENDER_SOURCE_LAUNCH_ID` binds both to that launch. A schema 1 command
contains `launchId`, a positive monotonic `epoch`, a 64-character hexadecimal
`revision`, `control: "engine"`, and `source`, which is null or an existing
height/divisor object with an optional source method. Commands are limited to
4096 bytes, and malformed, foreign-launch and stale commands leave the accepted
source in place. The status reports the accepted identities, requested source,
actual viewport scale, scaler mode and physical viewport texture extent, plus a
reason when the active camera or renderer cannot apply the request. Results are
written only when the candidate or applied state changes.

The [Viewport documentation](https://docs.godotengine.org/en/4.4/classes/class_viewport.html#class-viewport-property-scaling-3d-scale)
describes the 3D buffer scaling property.

To add the helper without changing the game, the launcher uses Godot's
`override.cfg` file. Godot 4.4 reads this file beside the file passed with
`--main-pack`, from an automatically found pack and beside the executable, or in
the `--path` project folder (`ProjectSettings::_setup` in
`core/config/project_settings.cpp`). By contrast,
`application/config/project_settings_override` is read from the project's own
settings, no command-line option adds a setting or autoload, and `--main-pack`
accepts only pack files. A launch that loads the helper therefore receives a
per-game `override.cfg` in `modules/godot/camera/<id>/`, which keeps the original
settings and autoloads.

This per-game folder also holds links to the game's files. Packed games use a link
to their original PCK, and project launches use links to every original project
entry, the `.godot` import cache included, so reads and writes reach the same
files as a direct launch. The working directory, however, stays the original game
folder. The game pack, project configuration, native executable and bundle remain
unchanged, and project application settings continue to determine the save
directory. The scripts and native library reside in the unpacked graphics runtime,
outside Electron archives.

Preparing the helper is optional at launch. If the helper is unavailable, or the
private override or cache cannot be written, the original pack, project or
native app remains the launch target. The launch log then reports the
unavailable renderer controls, while independent shared shader and spatial
stages remain eligible, and saved graphics settings are preserved. A row that
needs the helper but is selected during a launch without it takes effect on the
next launch.

## Camera and frame contract

The camera data is gathered in Godot's `POST_TRANSPARENT` compositor callback,
which runs on Godot's rendering thread. The callback reads that frame's
`RenderSceneData` projection and the color, depth and velocity texture slices
from `RenderSceneBuffersRD`, and `RenderingDevice.get_driver_resource` provides
their native Metal identities.

Camera values come from Godot's GPU projection, which includes reverse-Z depth in
the interval `[0, 1]`, Y inversion and temporal jitter. For its perspective
coefficients `A = P[2][2]` and `B = P[3][2]`, the near and far distances are
`B / (A + 1)` and `B / A`, and the vertical field of view is
`2 * atan(1 / abs(P[1][1]))`. Godot's ordinary `Projection` clip-plane helpers
are not used on this GPU matrix, because they assume OpenGL depth. Instead of
supplying guessed clip planes, the helper rejects unsupported projection shapes.

The helper's GDExtension library sends these values as a 64-byte
`RSTemporalCamera` packet through `rsSetTemporalCameraForTextures`, with reverse
depth and scene-linear HDR flags. The shared runtime consumes the packet once,
and only when all three texture identities match the native scaler. Godot
completes each frame's draw graph before the next frame's compositor callbacks,
and the helper clears its pending registration at the next callback and on
destruction. It does not use deferred `frame_post_draw` callbacks to correlate
frames, and it neither submits commands nor waits for GPU completion.

## Build and payload

The helper's native library uses only Godot's public GDExtension C header, and
no Godot C++ ABI or private object layout. MacLauncher Builds compiles it from the
Godot source at the commit its submodule records, and `source.json` records the
SHA-256 of the consumed header.

The build requires the Xcode command-line tools and produces a universal arm64 and
x86_64 library for macOS 13 or later. The shared graphics component includes this
output as its `godot/` folder, which contains `provider.json`,
`libmaclauncher-godot-camera.dylib`, `autoload.gd`, `camera-effect.gd` and
`GODOT-LICENSE.txt`. Godot's own OS and renderer requirements also apply.

The Godot module's `resolveGraphicsInputs` hook reports the available camera
producer for a compatible installed Godot runtime or for a recognized native app
with a compatible PCK header. Rendering requirements, however, are checked inside
the game. The native launch hook supplies only prepared arguments and
environment, and the shared launcher keeps the original app executable and Steam
environment.

Godot is distributed under the MIT license. Its
[compositor documentation](https://docs.godotengine.org/en/4.4/tutorials/rendering/compositor.html)
describes the public rendering callback and buffer access interfaces.

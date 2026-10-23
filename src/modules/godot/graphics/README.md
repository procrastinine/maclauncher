# Godot graphics integration

The included camera helper connects Godot 4.4 and later 4.x releases to the shared
native temporal upscalers. It supports the Metal Forward+ renderer, finite
perspective cameras and single-view viewports. Compatibility, Mobile, XR,
orthographic and custom oblique projections retain the engine's rendering path.

Managed Godot launches and recognized native Godot app bundles receive an inactive
autoload. Selecting a temporal method attaches a compositor effect to each eligible
viewport's active camera and selects Godot's MetalFX Temporal input path. The shared
graphics runtime applies the selected MetalFX or FidelityFX implementation. The
Temporal selection leaves the game's render scale unchanged. Game default removes the camera effect and
restores the original compositor and viewport scaler. Existing game compositor
effects and later camera changes are preserved. The inactive helper reads only the
shared cached selection; it adds no render callback or GPU work.

## Render source control

The helper also supports Godot's root viewport 3D render scale with Forward+ and
Mobile rendering, independently of the camera extension. This path requires an
active 3D camera and a non-XR root viewport. Compatibility rendering and child
viewports retain their existing scales. The window, final drawable, GUI and input
coordinates retain their dimensions.

`RESHADE_RENDER_SOURCE_CONTROL=engine` enables this control. `RESHADE_RENDER_HEIGHT`
requests an exact height bounded by the physical viewport output;
`RESHADE_RENDER_MAX_HEIGHT` caps the existing render height; and
`RESHADE_RENDER_MULTIPLIER` accepts output divisors 1, 1.5, 2 and 3. Exact height
takes precedence over the cap, followed by the divisor. Caps and divisors preserve
an existing lower game scale. Requested scales follow the public Viewport range
of 0.1 through 2.0, so very small requested heights may reach that lower limit.

The helper reads the root viewport texture extent and adjusts only
`Viewport.scaling_3d_scale`, following window and viewport changes. Game-written
scale updates become the baseline for later caps and restoration. An inactive
3D view or helper removal restores the baseline when the helper still owns the
current value. Without explicit engine control, no resolution processing runs.
For Simple bilinear, MetalFX or FSR 1 scaling with neural and temporal rendering
off, the helper selects the matching Godot viewport scaling mode. MetalFX requires
Godot's Metal driver. This reconstructs the reduced 3D buffer before full-resolution
GUI composition. Advanced effect plans select an engine filter explicitly with
`RESHADE_RENDER_SOURCE_METHOD`; this takes precedence over the Simple selection.
Without an explicit engine filter, Advanced retains the game's viewport filter.
Mode changes made by the game are preserved for later
restoration, and temporal camera integration takes precedence while active.

Provider metadata advertises `sourceResolutionAPI: 1` for this script contract.
The source adapter declares the bilinear, MetalFX and FSR 1 methods.
Older provider stages expose camera support without render source controls.
Stages with `sourceResolutionLiveAPI: 1` and the matching recorded autoload
hash also advertise `sourceResolution.live: true`. A dormant control channel
allows changes during play, including a launch with graphics effects off.
It polls at 100 ms intervals without per-frame JSON parsing. A null request
leaves the game's scale and filter unchanged until the helper owns a source
override; removing an override restores only values still owned by the helper.

`RESHADE_RENDER_SOURCE_CONTROL_FILE` names the launch's atomic JSON command,
`RESHADE_RENDER_SOURCE_STATUS_FILE` names its result, and
`RESHADE_RENDER_SOURCE_LAUNCH_ID` binds both to that launch. Schema 1 commands
contain `launchId`, a positive monotonic `epoch`, a 64-character hexadecimal
`revision`, `control: "engine"`, and `source`. The source is null or an existing
height/divisor object with an optional source method. Commands are bounded to
4096 bytes. Malformed, foreign-launch and stale commands retain the accepted
source. Status reports the accepted identities, requested source, actual
viewport scale, scaler mode and physical viewport texture extent, plus a reason
when the active camera or renderer cannot apply the request. Results are written
only when the candidate or applied state changes.

The [Viewport documentation](https://docs.godotengine.org/en/4.4/classes/class_viewport.html#class-viewport-property-scaling-3d-scale)
describes the 3D buffer scaling property.

The launcher prepares a per-game `override.cfg`, keeping the original settings and
autoloads. Packed games use a link to their original PCK; project launches use links
to the original resources with a separate writable import cache. The game pack,
project configuration, native executable and bundle remain unchanged. Project
application settings continue to determine the save directory. The scripts and
native library reside in the unpacked graphics runtime, outside Electron archives.

Graphics bridge preparation is optional at launch. An unavailable helper or an
unwritable private override/cache leaves the original pack, project or native app
as the launch target. The launch log reports the unavailable renderer controls;
independent shared shader and spatial stages remain eligible. Saved graphics
settings are preserved. An available inactive autoload is retained for live camera
and source selection, without installing a camera render callback while inactive.

## Camera and frame contract

The `POST_TRANSPARENT` compositor callback runs on Godot's rendering thread. It
reads that frame's `RenderSceneData` projection and the color, depth and velocity
texture slices from `RenderSceneBuffersRD`. `RenderingDevice.get_driver_resource`
provides their native Metal identities.

The GPU projection includes reverse-Z depth in the interval `[0, 1]`, Y inversion
and temporal jitter. For its perspective coefficients `A = P[2][2]` and
`B = P[3][2]`, near and far distances are `B / (A + 1)` and `B / A`; vertical field
of view is `2 * atan(1 / abs(P[1][1]))`. The ordinary `Projection` clip-plane
helpers assume OpenGL depth and are not used on this GPU matrix. The producer
rejects unsupported projection shapes instead of supplying guessed clip planes.

The GDExtension sends a 64-byte `RSTemporalCamera` packet through
`rsSetTemporalCameraForTextures`, with reverse depth and scene-linear HDR flags.
The shared runtime consumes it once only when all three texture identities match
the native scaler. Godot completes each frame's draw graph before the next frame's
compositor callbacks. The producer clears its pending registration at the next
callback and on destruction. It does not use deferred `frame_post_draw` callbacks
to correlate frames and does not submit commands or wait for GPU completion.

## Build and payload

`source.json` records the pinned Godot source and SHA-256 of the consumed public
GDExtension C header. No Godot C++ ABI or private object layout is used.

```sh
node src/modules/godot/graphics/build.mjs src/external/godot-camera /path/to/output
```

The build requires the Xcode command-line tools and produces a universal arm64 and
x86_64 library for macOS 13 or later. The shared graphics payload includes this
output as `godot/`, containing `provider.json`,
`libmaclauncher-godot-camera.dylib`, `autoload.gd`, `camera-effect.gd` and
`GODOT-LICENSE.txt`. Godot's own OS and renderer requirements also apply.

The module's `resolveGraphicsInputs` hook reports the available camera producer
for a compatible installed managed runtime or a recognized native app with a
compatible PCK header. Rendering requirements are checked inside the game. The
native launch hook supplies only prepared arguments and environment; the shared
launcher retains the original app executable and Steam environment.

Godot is distributed under the MIT license. Its
[compositor documentation](https://docs.godotengine.org/en/4.4/tutorials/rendering/compositor.html)
describes the public rendering callback and buffer access interfaces.

# Metal temporal processing

`frame.h` defines the shared version 1 temporal frame API. The injected graphics
library exports `rsProcessTemporalFrame` and `rsReleaseTemporalOwner`.
MetalFX Temporal uses Apple's MetalFX encoder. The optional FSR providers execute
FSR2, FSR3.1 and FSR4.1 algorithms through Metal; these names never select DLSS or
substitute another algorithm in the explicit API.

Color, depth, motion vectors, exposure, jitter and dimensions describe the same
scene frame. Color and masks use linear values. Motion vectors map the current
frame to the previous frame after the supplied pixel scales. Masks use the color
region's origin. Camera planes and vertical field of view are required by FSR2/3;
the camera-valid flag means the renderer actually supplied them. A final image,
window size or depth attachment alone cannot establish these inputs.

The explicit MetalFX encoder uses retaining classic Metal command buffers and a
private output texture. Each owner accepts one pending frame. Commands remain
uncommitted, and encoding never waits for the GPU. Release the owner when stopping
or discarding an unsubmitted frame; some MetalFX implementations retain their
latest commands. Releasing an owner resets subsequent history. Resource-retaining
command buffers continue to own already encoded Metal work.

Native and Wine applications with an existing MetalFX temporal scaler can switch
between their original scaler and FSR4. The adapter captures the scaler's declared
textures and settings rather than guessing render targets. Classic Metal fences
remain ordered around the replacement graph. Metal4 scalers with an explicit
MetalFX fence retain their original implementation. A missing provider, unsupported
input layout or busy provider also preserves the original scaler. Returning to the
original scaler resets its history. FSR2/3 require an integration that additionally
supplies camera projection data; the generic MetalFX interface does not supply it.

`camera.h` adds camera metadata to an existing scaler without replacing the
renderer. `rsSetTemporalCamera` copies a 64-byte versioned packet and binds it to
one exact scaler and uncommitted command buffer. The next encode consumes it,
including Game default. The packet supplies positive near/far distances, vertical
FOV in radians, frame and viewport IDs, frame duration and scene flags. Infinite
depth uses a zero far distance and the infinite-depth flag. Orthographic or custom
projections must not be submitted as perspective cameras. Reverse-Z must agree
with the scaler. Frame discontinuities or viewport changes reset temporal history.

Renderers that defer native command encoding can instead register the exact color,
depth and motion textures with `rsSetTemporalCameraForTextures`. All three must
match one scaler encode. The renderer must finish encoding the previous frame
before the next registration, clear its owner at frame boundaries and clear it on
destruction. Conflicting registrations invalidate the pending camera rather than
replacing it. No texture readback or GPU synchronization is introduced. Renderers
without camera registrations take an atomic check and skip the registration lock.

The [Godot integration](../../../godot/graphics/README.md) supplies camera metadata
from its compositor. The [Streamline integration](../../../crossover/temporal/streamline/README.md)
scopes game camera constants to a matching frame and viewport; the adapted DXMT
path carries the copied packet through deferred rendering to the native scaler.
Other native renderers can use the same camera API or submit the complete frame
API. Camera capability comes from the selected module integration and is saved
with the launch, so live switching cannot acquire a newly installed bridge midway
through a running game.

The launcher publishes a separate 24-byte `MLTMCTL1` packet for temporal method and
sharpness. Rendering threads cache it and check for replacement at most ten times
per second. Provider libraries load on first activation and compiled pipelines are
reused. Initial activation or a resolution change can compile new pipelines.
Game default bypasses provider processing; the game's own scaler remains active.

The [FSR2/3 provider](fsr/README.md) and [FSR4 provider](fsr4/README.md) describe
their input requirements, source revisions, build commands and supported systems.
These providers upscale frames. LSFG frame generation remains a separate option.

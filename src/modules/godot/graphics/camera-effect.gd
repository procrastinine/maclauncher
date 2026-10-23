extends CompositorEffect

var bridge: RefCounted
var viewport_id: int
var frame_id := 0
var previous_time := 0

func _init() -> void:
	effect_callback_type = EFFECT_CALLBACK_TYPE_POST_TRANSPARENT
	access_resolved_color = true
	access_resolved_depth = true
	needs_motion_vectors = true
	bridge = ClassDB.instantiate("MacLauncherTemporalCameraBridge")

func _render_callback(callback_type: int, render_data: RenderData) -> void:
	# Godot finishes the preceding frame's draw graph before invoking this
	# viewport's next callback. Unconsumed registrations cannot cross this point.
	bridge.clear()
	if callback_type != EFFECT_CALLBACK_TYPE_POST_TRANSPARENT or bridge.method() == 0:
		return
	var buffers := render_data.get_render_scene_buffers() as RenderSceneBuffersRD
	var scene := render_data.get_render_scene_data()
	if buffers == null or scene == null or scene.get_view_count() != 1:
		return
	var projection := scene.get_cam_projection()
	# RenderSceneData exposes the GPU projection, including reverse-Z [0, 1],
	# Y inversion and temporal jitter. Projection's clip-plane helpers instead
	# assume OpenGL [-1, 1]. Recover the actual camera from its Z coefficients.
	if projection.is_orthogonal() or abs(projection.z.w + 1.0) > 0.00001 or abs(projection.w.w) > 0.00001 or projection.z.z <= 0.0 or projection.w.z <= 0.0:
		return
	if abs(projection.x.z) > 0.00001 or abs(projection.y.z) > 0.00001 or abs(projection.x.y) > 0.00001 or abs(projection.y.x) > 0.00001 or abs(projection.w.x) > 0.00001 or abs(projection.w.y) > 0.00001:
		return
	var near_plane := projection.w.z / (projection.z.z + 1.0)
	var far_plane := projection.w.z / projection.z.z
	var vertical_fov := 2.0 * atan(1.0 / abs(projection.y.y))
	if not is_finite(near_plane) or not is_finite(far_plane) or not is_finite(vertical_fov):
		return
	var color := buffers.get_color_layer(0)
	var depth := buffers.get_depth_layer(0)
	var motion := buffers.get_velocity_layer(0)
	if not color.is_valid() or not depth.is_valid() or not motion.is_valid():
		return
	var device := RenderingServer.get_rendering_device()
	var now := Time.get_ticks_usec()
	var delta_ms := float(now - previous_time) / 1000.0 if previous_time != 0 else 0.0
	previous_time = now
	frame_id += 1
	bridge.submit(device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, color, 0),
		device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, depth, 0),
		device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, motion, 0),
		near_plane, far_plane, vertical_fov, min(delta_ms, 1000.0), frame_id, viewport_id)

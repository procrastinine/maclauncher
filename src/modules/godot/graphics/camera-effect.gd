extends CompositorEffect

var bridge: RefCounted
var viewport_id: int
var frame_id := 0
var previous_time := 0
var aov_capture: CompositorEffect
var frame_time_ms := 0.0

func _init() -> void:
	effect_callback_type = EFFECT_CALLBACK_TYPE_POST_TRANSPARENT
	access_resolved_color = true
	access_resolved_depth = true
	needs_motion_vectors = true
	bridge = ClassDB.instantiate("MacLauncherTemporalCameraBridge")

func _render_callback(callback_type: int, render_data: RenderData) -> void:
	# Godot finishes the preceding frame's draw graph before invoking this
	# viewport's next callback. Unconsumed registrations cannot cross this point.
	if aov_capture == null or not aov_capture.enabled:
		bridge.clear()
	if callback_type != EFFECT_CALLBACK_TYPE_POST_TRANSPARENT or not bridge.needs_scene():
		return
	var buffers := render_data.get_render_scene_buffers() as RenderSceneBuffersRD
	var scene := render_data.get_render_scene_data()
	if buffers == null or scene == null or scene.get_view_count() != 1:
		return
	if aov_capture == null or not aov_capture.enabled or not aov_capture.frame_pending:
		begin_scene_frame()
	register_scene(buffers, scene, true)
	if aov_capture != null and aov_capture.enabled:
		aov_capture.submit_final(buffers, buffers.get_color_layer(0), buffers.get_depth_layer(0), buffers.get_velocity_layer(0))
		aov_capture.frame_pending = false

func begin_scene_frame() -> int:
	var now := Time.get_ticks_usec()
	frame_time_ms = min(float(now - previous_time) / 1000.0, 1000.0) if previous_time != 0 else 0.0
	previous_time = now
	frame_id += 1
	return frame_id

func register_scene(buffers: RenderSceneBuffersRD, scene: RenderSceneData, destination: bool, captured_depth: RID = RID(), captured_motion: RID = RID()) -> bool:
	var projection := scene.get_cam_projection()
	# Camera parameters are optional; guides and actual matrices are independent.
	var camera := _perspective_camera(projection)
	var color := buffers.get_color_layer(0)
	var depth := captured_depth if captured_depth.is_valid() else buffers.get_depth_layer(0)
	var motion := captured_motion if captured_motion.is_valid() else buffers.get_velocity_layer(0)
	if not color.is_valid() or not depth.is_valid() or not motion.is_valid():
		return false
	var device := RenderingServer.get_rendering_device()
	var color_native := device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, color, 0)
	var depth_native := device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, depth, 0)
	var motion_native := device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, motion, 0)
	if camera.size() == 3:
		if destination:
			bridge.submit(color_native, depth_native, motion_native,
				camera[0], camera[1], camera[2], frame_time_ms, frame_id, viewport_id)
		else:
			bridge.stage(color_native, depth_native, motion_native,
				camera[0], camera[1], camera[2], frame_time_ms, frame_id, viewport_id)
	var view: Transform3D = scene.get_cam_transform().affine_inverse()
	var submit_matrix: Callable = bridge.submit_matrices if destination else bridge.stage_matrices
	submit_matrix.call(color_native, depth_native, motion_native, frame_id,
		view.basis.x.x, view.basis.y.x, view.basis.z.x, view.origin.x,
		view.basis.x.y, view.basis.y.y, view.basis.z.y, view.origin.y,
		view.basis.x.z, view.basis.y.z, view.basis.z.z, view.origin.z,
		0.0, 0.0, 0.0, 1.0,
		projection.x.x, projection.y.x, projection.z.x, projection.w.x,
		projection.x.y, projection.y.y, projection.z.y, projection.w.y,
		projection.x.z, projection.y.z, projection.z.z, projection.w.z,
		projection.x.w, projection.y.w, projection.z.w, projection.w.w)

	if destination:
		bridge.submit_destination(color_native, depth_native, motion_native, frame_id)
	return true

func _perspective_camera(projection: Projection) -> PackedFloat32Array:
	var camera := PackedFloat32Array()
	if not projection.is_orthogonal() and abs(projection.z.w + 1.0) <= 0.00001 and abs(projection.w.w) <= 0.00001 and projection.z.z > 0.0 and projection.w.z > 0.0:
		if abs(projection.x.z) <= 0.00001 and abs(projection.y.z) <= 0.00001 and abs(projection.x.y) <= 0.00001 and abs(projection.y.x) <= 0.00001 and abs(projection.w.x) <= 0.00001 and abs(projection.w.y) <= 0.00001:
			var near_plane := projection.w.z / (projection.z.z + 1.0)
			var far_plane := projection.w.z / projection.z.z
			var vertical_fov := 2.0 * atan(1.0 / abs(projection.y.y))
			if is_finite(near_plane) and is_finite(far_plane) and is_finite(vertical_fov):
				camera = PackedFloat32Array([near_plane, far_plane, vertical_fov])
	return camera

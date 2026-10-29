extends CompositorEffect

const NORMAL := 1 << 0
const ROUGHNESS := 1 << 1
const RADIANCE := 1 << 2
const SPECULAR := 1 << 3
const METALLIC := 1 << 11
const SUPPLIED := NORMAL | ROUGHNESS | RADIANCE | SPECULAR | METALLIC
const COLOR_INCLUDES_SPECULAR := 4
const SPECULAR_MERGE_PENDING := 8

var bridge: RefCounted
var camera_source: WeakRef
var frame_id := 0
var viewport_id := 0
var requested := 0
var slot := 0
var captured_size := Vector2i.ZERO
var snapshots: Array[Dictionary] = [{}, {}, {}]
var programs := {}
var sampler := RID()
var desired_key := ""
var preparation_queued := false
var prepare_epoch := 0
var failed_contracts := {}
var started := false
var retiring := false
var disposed := false
var disposal_queued := false
var frame_pending := false

func _init() -> void:
	enabled = false
	effect_callback_type = EFFECT_CALLBACK_TYPE_POST_SKY
	access_resolved_color = true
	access_resolved_depth = true
	needs_motion_vectors = true

func configure_demand() -> void:
	var demand := int(bridge.aov_demand()) & SUPPLIED if bridge != null else 0
	if demand == 0:
		if started:
			retire()
			dispose_if_idle()
		return
	if retiring:
		if not dispose_if_idle() or not bridge.resume_aovs():
			return
		retiring = false
		disposed = false
		disposal_queued = false
		frame_pending = false
	started = true
	enabled = true
	needs_normal_roughness = (demand & (NORMAL | ROUGHNESS)) != 0
	# Radiance has one precise meaning here: the original pre-specular-merge
	# scene signal. Request the renderer's actual separate target for that data.
	needs_separate_specular = (demand & (RADIANCE | SPECULAR | METALLIC)) != 0

func _native(device: RenderingDevice, image: RID) -> int:
	return device.get_driver_resource(RenderingDevice.DRIVER_RESOURCE_TEXTURE, image, 0) if image.is_valid() else 0

func _format_matches(device: RenderingDevice, image: RID, extent: Vector2i, format: int = -1) -> bool:
	if not image.is_valid() or not device.texture_is_valid(image):
		return false
	var info := device.texture_get_format(image)
	return info != null and info.samples == RenderingDevice.TEXTURE_SAMPLES_1 and info.width == extent.x and info.height == extent.y and (format == -1 or info.format == format)

func _sources(device: RenderingDevice, buffers: RenderSceneBuffersRD) -> Dictionary:
	var sources := {"color": buffers.get_color_layer(0), "depth": buffers.get_depth_layer(0), "motion": buffers.get_velocity_layer(0)}
	if not _format_matches(device, sources.color, captured_size, RenderingDevice.DATA_FORMAT_R16G16B16A16_SFLOAT) or not _format_matches(device, sources.depth, captured_size) or not _format_matches(device, sources.motion, captured_size, RenderingDevice.DATA_FORMAT_R16G16_SFLOAT):
		return {}
	var variant := 0
	if requested & (NORMAL | ROUGHNESS) and buffers.has_texture("forward_clustered", "normal_roughness"):
		var image := buffers.get_texture_slice("forward_clustered", "normal_roughness", 0, 0, 1, 1)
		if _format_matches(device, image, captured_size, RenderingDevice.DATA_FORMAT_R8G8B8A8_UNORM):
			sources["normal"] = image
			variant |= 1
	if requested & (RADIANCE | SPECULAR | METALLIC) and buffers.has_texture("forward_clustered", "specular"):
		var image := buffers.get_texture_slice("forward_clustered", "specular", 0, 0, 1, 1)
		if _format_matches(device, image, captured_size, RenderingDevice.DATA_FORMAT_R16G16B16A16_SFLOAT):
			sources["specular"] = image
			variant |= 2
	if not needs_separate_specular or not sources.has("specular"):
		requested &= ~RADIANCE
	sources["variant"] = variant
	sources["width"] = captured_size.x
	sources["height"] = captured_size.y
	return sources

func _key(sources: Dictionary) -> String:
	return "%s:%s:%s:%s:%s:%s:%s:%s" % [sources.width, sources.height, sources.variant, sources.color.get_id(), sources.depth.get_id(), sources.motion.get_id(), sources.get("normal", RID()).get_id(), sources.get("specular", RID()).get_id()]

func _uniform(binding: int, type: int, ids: Array) -> RDUniform:
	var uniform := RDUniform.new()
	uniform.binding = binding
	uniform.uniform_type = type
	for id in ids:
		uniform.add_id(id)
	return uniform

func _image(device: RenderingDevice, format: int, extent: Vector2i) -> RID:
	var info := RDTextureFormat.new()
	info.format = format
	info.width = extent.x
	info.height = extent.y
	info.texture_type = RenderingDevice.TEXTURE_TYPE_2D
	info.usage_bits = RenderingDevice.TEXTURE_USAGE_SAMPLING_BIT | RenderingDevice.TEXTURE_USAGE_STORAGE_BIT | RenderingDevice.TEXTURE_USAGE_CAN_COPY_FROM_BIT | RenderingDevice.TEXTURE_USAGE_CAN_COPY_TO_BIT
	return device.texture_create(info, RDTextureView.new())

func _free_snapshot(device: RenderingDevice, record: Dictionary) -> void:
	if record.has("uniforms") and device.uniform_set_is_valid(record.uniforms):
		device.free_rid(record.uniforms)
	for image in record.get("textures", {}).values():
		if device.texture_is_valid(image):
			device.free_rid(image)

func _program(device: RenderingDevice, variant: int) -> Dictionary:
	if programs.has(variant):
		return programs[variant]
	var file: String = get_script().resource_path.get_base_dir().path_join("aov-capture-%s.spv" % variant)
	var bytes := FileAccess.get_file_as_bytes(file)
	if bytes.size() < 20:
		return {}
	var spirv := RDShaderSPIRV.new()
	spirv.set_stage_bytecode(RenderingDevice.SHADER_STAGE_COMPUTE, bytes)
	var shader := device.shader_create_from_spirv(spirv)
	if not shader.is_valid():
		return {}
	var pipeline := device.compute_pipeline_create(shader)
	if not pipeline.is_valid():
		device.free_rid(shader)
		return {}
	var program := {"shader": shader, "pipeline": pipeline}
	programs[variant] = program
	return program

func _prepare_capture(sources: Dictionary, key: String, epoch: int) -> void:
	if epoch != prepare_epoch:
		return
	preparation_queued = false
	if retiring or key != desired_key:
		return
	var device := RenderingServer.get_rendering_device()
	for name in ["color", "depth", "motion"]:
		if not device.texture_is_valid(sources[name]):
			return
	var program := _program(device, sources.variant)
	if program.is_empty():
		failed_contracts[key] = true
		push_warning("Godot scene attachments could not be prepared.")
		return
	if not sampler.is_valid():
		var state := RDSamplerState.new()
		state.min_filter = RenderingDevice.SAMPLER_FILTER_NEAREST
		state.mag_filter = RenderingDevice.SAMPLER_FILTER_NEAREST
		state.repeat_u = RenderingDevice.SAMPLER_REPEAT_MODE_CLAMP_TO_EDGE
		state.repeat_v = RenderingDevice.SAMPLER_REPEAT_MODE_CLAMP_TO_EDGE
		sampler = device.sampler_create(state)
	if not sampler.is_valid():
		failed_contracts[key] = true
		return
	var formats := {"radiance": RenderingDevice.DATA_FORMAT_R16G16B16A16_SFLOAT, "depth": RenderingDevice.DATA_FORMAT_R32_SFLOAT, "motion": RenderingDevice.DATA_FORMAT_R16G16_SFLOAT}
	if sources.variant & 1:
		formats["normal"] = RenderingDevice.DATA_FORMAT_R8G8B8A8_UNORM
	if sources.variant & 2:
		formats["specular"] = RenderingDevice.DATA_FORMAT_R16G16B16A16_SFLOAT
	for index in range(snapshots.size()):
		if not bridge.aov_slot_idle(index + 1) or snapshots[index].get("key", "") == key:
			continue
		var textures := {}
		for name in formats:
			textures[name] = _image(device, formats[name], Vector2i(sources.width, sources.height))
			if not textures[name].is_valid():
				_free_snapshot(device, {"textures": textures})
				failed_contracts[key] = true
				return
		var uniforms: Array[RDUniform] = []
		for binding in range(3):
			uniforms.append(_uniform(binding, RenderingDevice.UNIFORM_TYPE_SAMPLER_WITH_TEXTURE, [sampler, sources[["color", "depth", "motion"][binding]]]))
		for binding in range(3):
			uniforms.append(_uniform(binding + 5, RenderingDevice.UNIFORM_TYPE_IMAGE, [textures[["radiance", "depth", "motion"][binding]]]))
		for pair in [["normal", 3, 8], ["specular", 4, 9]]:
			if textures.has(pair[0]):
				uniforms.append(_uniform(pair[1], RenderingDevice.UNIFORM_TYPE_SAMPLER_WITH_TEXTURE, [sampler, sources[pair[0]]]))
				uniforms.append(_uniform(pair[2], RenderingDevice.UNIFORM_TYPE_IMAGE, [textures[pair[0]]]))
		var uniform_set := device.uniform_set_create(uniforms, program.shader, 0)
		if not uniform_set.is_valid() or retiring or epoch != prepare_epoch:
			_free_snapshot(device, {"textures": textures, "uniforms": uniform_set})
			failed_contracts[key] = true
			return
		_free_snapshot(device, snapshots[index])
		snapshots[index] = {"key": key, "textures": textures, "uniforms": uniform_set, "pipeline": program.pipeline, "captured": false}

func _queue_preparation(sources: Dictionary, key: String) -> void:
	desired_key = key
	if preparation_queued or failed_contracts.has(key):
		return
	preparation_queued = true
	var retained = self
	var epoch := prepare_epoch
	RenderingServer.call_on_render_thread(func(): retained._prepare_capture(sources, key, epoch))

func _render_callback(callback_type: int, render_data: RenderData) -> void:
	if callback_type != EFFECT_CALLBACK_TYPE_POST_SKY or retiring:
		return
	bridge.clear()
	if slot != 0:
		bridge.release_aov_slot(slot)
		slot = 0
	var camera = camera_source.get_ref() if camera_source != null else null
	if camera == null:
		return
	frame_id = camera.begin_scene_frame()
	frame_pending = true
	requested = int(bridge.aov_demand()) & SUPPLIED
	if requested == 0 or not bridge.needs_scene() or not bridge.scene_copy_available():
		return
	var buffers := render_data.get_render_scene_buffers() as RenderSceneBuffersRD
	var scene := render_data.get_render_scene_data()
	if buffers == null or scene == null or scene.get_view_count() != 1:
		return
	captured_size = buffers.get_internal_size()
	var device := RenderingServer.get_rendering_device()
	var sources := _sources(device, buffers)
	if sources.is_empty():
		return
	var key := _key(sources)
	slot = bridge.acquire_aov_slot()
	if slot == 0:
		return
	var record: Dictionary = snapshots[slot - 1]
	if record.get("key", "") != key:
		bridge.release_aov_slot(slot)
		slot = 0
		_queue_preparation(sources, key)
		return
	record.captured = false
	var textures: Dictionary = record.textures
	if not camera.register_scene(buffers, scene, false, textures.depth, textures.motion):
		bridge.release_aov_slot(slot)
		slot = 0
		return
	var flags := SPECULAR_MERGE_PENDING if needs_separate_specular and sources.has("specular") else 0
	if not bridge.submit_scene_copy(_native(device, sources.color), _native(device, textures.depth), _native(device, textures.motion),
		_native(device, textures.get("normal", RID())), _native(device, textures.get("specular", RID())), _native(device, textures.radiance),
		frame_id, viewport_id, slot, captured_size.x, captured_size.y, requested, flags, 1.0, camera.frame_time_ms):
		bridge.release_aov_slot(slot)
		slot = 0
		return
	var compute := device.compute_list_begin()
	device.compute_list_bind_compute_pipeline(compute, record.pipeline)
	device.compute_list_bind_uniform_set(compute, record.uniforms, 0)
	device.compute_list_dispatch(compute, int(ceil(float(captured_size.x) / 8.0)), int(ceil(float(captured_size.y) / 8.0)), 1)
	device.compute_list_end()
	record.captured = true
	record["flags"] = flags
	# The capture compute writes every immutable guide and attachment. This
	# identity return copy depends on that operation and writes the engine color
	# before its later specular merge/transparency passes.
	if device.texture_copy(textures.radiance, sources.color, Vector3.ZERO, Vector3.ZERO, Vector3(captured_size.x, captured_size.y, 1), 0, 0, 0, 0) != OK:
		bridge.clear_scene_copy()

func submit_final(buffers: RenderSceneBuffersRD, color: RID, depth: RID, motion: RID) -> void:
	if slot == 0:
		return
	var device := RenderingServer.get_rendering_device()
	var record: Dictionary = snapshots[slot - 1]
	if record.get("captured", false) and buffers.get_internal_size() == captured_size:
		var textures: Dictionary = record.textures
		bridge.submit_aovs(_native(device, color), _native(device, depth), _native(device, motion),
			_native(device, textures.get("normal", RID())), _native(device, textures.get("specular", RID())), _native(device, textures.radiance),
			frame_id, viewport_id, slot, captured_size.x, captured_size.y, requested, (int(record.flags) & ~SPECULAR_MERGE_PENDING) | COLOR_INCLUDES_SPECULAR, 1.0)
	bridge.release_aov_slot(slot)
	slot = 0

func retire() -> void:
	if retiring:
		return
	retiring = true
	enabled = false
	needs_normal_roughness = false
	needs_separate_specular = false
	prepare_epoch += 1
	bridge.retire_aovs()
	slot = 0
	frame_pending = false

func dispose_if_idle() -> bool:
	if disposed:
		return true
	if not disposal_queued and bridge.aovs_idle():
		disposal_queued = true
		var retained = self
		RenderingServer.call_on_render_thread(func(): retained._dispose_images())
	return false

func _dispose_images() -> void:
	var device := RenderingServer.get_rendering_device()
	for record in snapshots:
		_free_snapshot(device, record)
	for program in programs.values():
		device.free_rid(program.pipeline)
		device.free_rid(program.shader)
	if sampler.is_valid():
		device.free_rid(sampler)
	sampler = RID()
	snapshots = [{}, {}, {}]
	programs.clear()
	failed_contracts.clear()
	preparation_queued = false
	disposed = true

func _notification(what: int) -> void:
	if what == NOTIFICATION_PREDELETE:
		# RenderingDevice owns teardown of any remaining producer RIDs. A core
		# GPU/redraw lease must never be shortened by Resource destruction.
		if not retiring and bridge != null:
			bridge.retire_aovs()

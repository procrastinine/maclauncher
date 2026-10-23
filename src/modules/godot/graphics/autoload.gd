extends Node

const SOURCE_CONTROL_API := 1
const SOURCE_CONTROL_MAX_BYTES := 4096
var bridge: RefCounted
var effect_script: Script
var viewports: Array[WeakRef] = []
var environments: Array[WeakRef] = []
var bindings := {}
var source_control_enabled := false
var source_height := 0
var source_max_height := 0
var source_multiplier := 0.0
var source_viewport: WeakRef
var source_original_scale := 1.0
var source_applied_scale := -1.0
var source_spatial_method := ""
var source_original_mode := -1
var source_applied_mode := -1
var source_control_file := ""
var source_status_file := ""
var source_launch_id := ""
var source_epoch := 0
var source_revision := ""
var source_live_active := false
var source_requested: Variant
var source_checked_bytes := ""
var source_last_status := ""
var source_status_key: Array = []
var source_control_error := ""

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process(false)
	_configure_source_control(RenderingServer.get_current_rendering_method())
	_configure_live_source_control()
	if source_control_enabled:
		set_process(true)
	if RenderingServer.get_current_rendering_method() != "forward_plus" or RenderingServer.get_current_rendering_driver_name() != "metal":
		push_warning("Temporal camera integration requires Godot Forward+ with the Metal renderer.")
		return
	var extension := OS.get_environment("MACLAUNCHER_GODOT_CAMERA_EXTENSION")
	if extension.is_empty() or GDExtensionManager.load_extension(extension) != GDExtensionManager.LOAD_STATUS_OK:
		push_warning("Godot temporal camera integration could not load.")
		return
	bridge = ClassDB.instantiate("MacLauncherTemporalCameraBridge")
	if bridge == null or not bridge.available():
		push_warning("Godot temporal camera integration requires the shared graphics runtime.")
		return
	effect_script = load(OS.get_environment("MACLAUNCHER_GODOT_CAMERA_SCRIPT"))
	get_tree().node_added.connect(_track)
	get_tree().node_removed.connect(_untrack)
	_track_tree(get_tree().root)
	set_process(true)

func _configure_live_source_control() -> void:
	source_control_file = OS.get_environment("RESHADE_RENDER_SOURCE_CONTROL_FILE")
	source_status_file = OS.get_environment("RESHADE_RENDER_SOURCE_STATUS_FILE")
	source_launch_id = OS.get_environment("RESHADE_RENDER_SOURCE_LAUNCH_ID")
	if source_control_file.is_empty() or source_launch_id.is_empty() or not source_control_file.is_absolute_path():
		source_control_file = ""
		return
	if not source_status_file.is_empty() and not source_status_file.is_absolute_path():
		source_status_file = ""
	var timer := Timer.new()
	timer.wait_time = 0.1
	timer.process_mode = Node.PROCESS_MODE_ALWAYS
	timer.timeout.connect(_poll_source_control)
	add_child(timer)
	timer.start()
	_poll_source_control()

func _source_rendering_method() -> String:
	return RenderingServer.get_current_rendering_method()

func _source_driver() -> String:
	return RenderingServer.get_current_rendering_driver_name()

func _source_integer(value: Variant, minimum: int, maximum: int) -> bool:
	return typeof(value) in [TYPE_INT, TYPE_FLOAT] and is_finite(float(value)) and float(value) == floorf(float(value)) and value >= minimum and value <= maximum

func _source_fields(value: Dictionary, allowed: Array) -> bool:
	for key in value:
		if key not in allowed:
			return false
	return true

func _decode_source_control(value: Variant) -> Dictionary:
	if not value is Dictionary or not _source_fields(value, ["schema", "launchId", "epoch", "revision", "control", "source"]):
		return {}
	if not _source_integer(value.get("schema"), 1, 1) or value.get("launchId") != source_launch_id or value.get("control") != "engine" or not value.has("source"):
		return {}
	if not _source_integer(value.get("epoch"), 1, 9007199254740991):
		return {}
	var revision: Variant = value.get("revision")
	if not revision is String or revision.length() != 64 or revision.to_lower() != revision or not revision.is_valid_hex_number(false):
		return {}
	var request: Variant = value.source
	if request != null:
		if not request is Dictionary or not _source_fields(request, ["height", "maximum", "multiplier", "method"]):
			return {}
		if request.has("height") == request.has("multiplier"):
			return {}
		if request.has("height") and not _source_integer(request.height, 1, 16384):
			return {}
		if request.has("multiplier") and (typeof(request.multiplier) not in [TYPE_INT, TYPE_FLOAT] or request.multiplier not in [1.0, 1.5, 2.0, 3.0]):
			return {}
		if request.has("maximum") and (not request.has("height") or not request.maximum is bool):
			return {}
		if request.has("method") and request.method not in ["bilinear", "metalfx", "fsr1"]:
			return {}
	return value

func _poll_source_control() -> void:
	if source_control_file.is_empty():
		return
	var input := FileAccess.open(source_control_file, FileAccess.READ)
	if input == null:
		return
	var size := input.get_length()
	if size < 1 or size > SOURCE_CONTROL_MAX_BYTES:
		input.close()
		_reject_source_control("Render source controls must contain at most 4096 bytes.")
		return
	var bytes := input.get_buffer(size).get_string_from_utf8()
	input.close()
	if bytes == source_checked_bytes:
		return
	source_checked_bytes = bytes
	var candidate := _decode_source_control(JSON.parse_string(bytes))
	if candidate.is_empty():
		_reject_source_control("Render source controls are invalid; the accepted source is retained.")
		return
	if int(candidate.epoch) <= source_epoch:
		if int(candidate.epoch) != source_epoch or candidate.revision != source_revision:
			_reject_source_control("An older render source change was ignored.")
		return
	var request: Variant = candidate.source
	if request != null and (_source_rendering_method() not in ["forward_plus", "mobile"] or request.get("method", "") == "metalfx" and _source_driver() != "metal"):
		_reject_source_control("The active Godot renderer cannot apply this source filter.")
		return
	source_epoch = int(candidate.epoch)
	source_revision = candidate.revision
	source_control_error = ""
	source_live_active = true
	source_requested = request.duplicate(true) if request != null else null
	source_height = int(request.get("height", 0)) if request != null and not request.get("maximum", false) else 0
	source_max_height = int(request.get("height", 0)) if request != null and request.get("maximum", false) else 0
	source_multiplier = float(request.get("multiplier", 0)) if request != null else 0.0
	source_spatial_method = request.get("method", "") if request != null else ""
	source_control_enabled = request != null
	_sync_source_resolution()
	if source_control_enabled:
		set_process(true)
	elif bridge == null:
		set_process(false)

func _reject_source_control(reason: String) -> void:
	source_control_error = reason
	_publish_source_status()

func _publish_source_status(reason: String = "") -> void:
	if source_status_file.is_empty():
		return
	var applied: Variant = null
	var scale := -1.0
	var mode := -1
	var extent := Vector2.ZERO
	if source_viewport != null and source_applied_scale >= 0.0:
		var viewport := source_viewport.get_ref() as Viewport
		if viewport != null:
			extent = _source_extent(viewport)
			scale = viewport.scaling_3d_scale
			mode = viewport.scaling_3d_mode
	var key := [source_epoch, source_revision, scale, mode, extent, reason, source_control_error]
	if key == source_status_key:
		return
	if scale >= 0.0:
		applied = {"scale": scale, "scalingMode": mode, "viewportWidth": extent.x, "viewportHeight": extent.y}
	var value := JSON.stringify({"schema": 1, "launchId": source_launch_id, "epoch": source_epoch, "revision": source_revision, "control": "engine", "requested": source_requested, "applied": applied, "reason": source_control_error if not source_control_error.is_empty() else reason})
	if value == source_last_status:
		return
	var temporary := source_status_file + ".tmp-" + str(get_instance_id())
	var output := FileAccess.open(temporary, FileAccess.WRITE)
	if output == null:
		return
	output.store_string(value)
	output.close()
	if DirAccess.rename_absolute(temporary, source_status_file) == OK:
		source_last_status = value
		source_status_key = key
	else:
		DirAccess.remove_absolute(temporary)

func _configure_source_control(method: String) -> void:
	source_control_enabled = false
	if OS.get_environment("RESHADE_RENDER_SOURCE_CONTROL") != "engine" or method not in ["forward_plus", "mobile"]:
		return
	source_height = 0
	source_max_height = 0
	source_multiplier = 0.0
	source_spatial_method = OS.get_environment("RESHADE_RENDER_SOURCE_METHOD")
	if source_spatial_method.is_empty():
		source_spatial_method = OS.get_environment("MACLAUNCHER_GODOT_SPATIAL_METHOD")
	for setting in ["RESHADE_RENDER_HEIGHT", "RESHADE_RENDER_MAX_HEIGHT"]:
		var text := OS.get_environment(setting)
		if text.is_empty():
			continue
		if not text.is_valid_int() or text.to_int() < 1 or text.to_int() > 16384:
			push_warning("Godot render height must be an integer from 1 to 16384.")
			return
		if setting == "RESHADE_RENDER_HEIGHT":
			source_height = text.to_int()
		else:
			source_max_height = text.to_int()
	var multiplier := OS.get_environment("RESHADE_RENDER_MULTIPLIER")
	if not multiplier.is_empty():
		if not multiplier.is_valid_float() or multiplier.to_float() not in [1.0, 1.5, 2.0, 3.0]:
			push_warning("Godot render divisor must be 1, 1.5, 2 or 3.")
			return
		source_multiplier = multiplier.to_float()
	source_control_enabled = source_height > 0 or source_max_height > 0 or source_multiplier > 0.0

func _source_scale(extent: Vector2, original: float) -> float:
	if extent.x < 1.0 or extent.y < 1.0 or not is_finite(extent.x) or not is_finite(extent.y):
		return original
	var desired := original
	if source_height > 0:
		desired = minf(float(source_height), extent.y) / extent.y
	elif source_max_height > 0:
		desired = minf(original, minf(1.0, float(source_max_height) / extent.y))
	elif source_multiplier > 0.0:
		desired = minf(original, minf(1.0, ceilf(extent.y / source_multiplier) / extent.y))
	return clampf(desired, 0.1, 2.0)

func _source_extent(viewport: Viewport) -> Vector2:
	return viewport.get_texture().get_size()

func _source_scaling_mode(driver: String) -> int:
	match source_spatial_method:
		"bilinear": return Viewport.SCALING_3D_MODE_BILINEAR
		"fsr1": return Viewport.SCALING_3D_MODE_FSR
		"metalfx":
			if driver == "metal": return Viewport.SCALING_3D_MODE_METALFX_SPATIAL
	return -1

func _restore_source_mode() -> void:
	if source_viewport != null:
		var viewport := source_viewport.get_ref() as Viewport
		if viewport != null and source_applied_mode >= 0 and viewport.scaling_3d_mode == source_applied_mode:
			viewport.scaling_3d_mode = source_original_mode
	source_applied_mode = -1

func _sync_source_mode(viewport: Viewport) -> void:
	var mode := _source_scaling_mode(_source_driver())
	if mode < 0 or not bindings.is_empty() or (bridge != null and bridge.method() != 0):
		_restore_source_mode()
		return
	if source_applied_mode < 0 or viewport.scaling_3d_mode != source_applied_mode:
		source_original_mode = viewport.scaling_3d_mode
	if viewport.scaling_3d_mode != mode:
		viewport.scaling_3d_mode = mode
	source_applied_mode = viewport.scaling_3d_mode

func _restore_source_resolution() -> void:
	_restore_source_mode()
	if source_viewport != null:
		var viewport := source_viewport.get_ref() as Viewport
		if viewport != null and is_equal_approx(viewport.scaling_3d_scale, source_applied_scale):
			viewport.scaling_3d_scale = source_original_scale
	source_viewport = null
	source_applied_scale = -1.0

func _sync_source_resolution() -> void:
	var viewport := get_tree().root
	if not source_control_enabled or (not source_live_active and OS.get_environment("RESHADE_RENDER_SOURCE_CONTROL") != "engine") or viewport.use_xr or viewport.disable_3d or viewport.get_camera_3d() == null:
		_restore_source_resolution()
		_publish_source_status("Waiting for an active non-XR root 3D camera." if source_control_enabled else "")
		return
	var extent := _source_extent(viewport)
	if extent.x < 1.0 or extent.y < 1.0:
		_restore_source_resolution()
		_publish_source_status("The root viewport has no render extent.")
		return
	var current := viewport.scaling_3d_scale
	# A game-written value becomes the baseline for both caps and restoration.
	if source_applied_scale < 0.0 or not is_equal_approx(current, source_applied_scale):
		source_original_scale = current
	var desired := _source_scale(extent, source_original_scale)
	if not is_equal_approx(current, desired):
		viewport.scaling_3d_scale = desired
	source_viewport = weakref(viewport)
	source_applied_scale = viewport.scaling_3d_scale
	_sync_source_mode(viewport)
	_publish_source_status("A temporal effect controls the source filter." if not source_spatial_method.is_empty() and source_applied_mode < 0 else "")

func _track_tree(node: Node) -> void:
	_track(node)
	for child in node.get_children():
		_track_tree(child)

func _track(node: Node) -> void:
	if node is Viewport:
		viewports.append(weakref(node))
	elif node is WorldEnvironment:
		environments.append(weakref(node))

func _untrack(node: Node) -> void:
	if node is Viewport:
		viewports = viewports.filter(func(reference: WeakRef): return reference.get_ref() != node and reference.get_ref() != null)
	elif node is WorldEnvironment:
		environments = environments.filter(func(reference: WeakRef): return reference.get_ref() != node and reference.get_ref() != null)

func _inherited_compositor(camera: Camera3D) -> Compositor:
	for reference in environments:
		var environment := reference.get_ref() as WorldEnvironment
		if environment != null and environment.is_inside_tree() and environment.get_viewport().find_world_3d() == camera.get_world_3d() and environment.compositor != null:
			return environment.compositor
	return null

func _restore(binding: Dictionary) -> void:
	var camera := binding.camera.get_ref() as Camera3D
	if camera != null and camera.compositor == binding.installed:
		camera.compositor = binding.original
	var viewport := binding.viewport.get_ref() as Viewport
	if viewport != null and viewport.scaling_3d_mode == Viewport.SCALING_3D_MODE_METALFX_TEMPORAL:
		viewport.scaling_3d_mode = binding.mode

func _sync_effects(binding: Dictionary, force: bool = false) -> void:
	var effects: Array[CompositorEffect] = []
	if binding.inherited != null:
		effects.assign(binding.inherited.compositor_effects)
	if force or effects != binding.effects:
		binding.effects = effects
		var installed_effects: Array[CompositorEffect] = effects.duplicate()
		installed_effects.append(binding.effect)
		binding.installed.compositor_effects = installed_effects

func _process(_delta: float) -> void:
	if source_control_enabled:
		_sync_source_resolution()
	if bridge == null:
		return
	var enabled: bool = bridge.method() != 0
	if not enabled and bindings.is_empty():
		return
	var now := Time.get_ticks_msec()
	var active := {}
	for reference in viewports:
		var viewport := reference.get_ref() as Viewport
		if viewport == null or not viewport.is_inside_tree():
			continue
		var key := viewport.get_instance_id()
		var camera := viewport.get_camera_3d()
		if not enabled or camera == null or camera.projection != Camera3D.PROJECTION_PERSPECTIVE or viewport.use_xr:
			continue
		active[key] = true
		var old: Dictionary = bindings.get(key, {})
		if not old.is_empty() and old.camera.get_ref() == camera and camera.compositor == old.installed and (old.original != null or old.inherited == _inherited_compositor(camera)):
			# Preserve changes made by the game to its render scale.
			if viewport.scaling_3d_mode != Viewport.SCALING_3D_MODE_METALFX_TEMPORAL:
				old.mode = viewport.scaling_3d_mode
				viewport.scaling_3d_mode = Viewport.SCALING_3D_MODE_METALFX_TEMPORAL
			# Compositor does not emit Resource.changed when its effect list changes.
			# Compare only occasionally, without rebuilding an unchanged compositor.
			if now >= old.next_effect_check:
				_sync_effects(old)
				old.next_effect_check = now + 250
			continue
		if not old.is_empty():
			_restore(old)
		var original := camera.compositor
		var inherited := original if original != null else _inherited_compositor(camera)
		var installed := Compositor.new()
		var effect = effect_script.new()
		effect.viewport_id = key
		bindings[key] = {"camera": weakref(camera), "viewport": reference, "original": original,
			"installed": installed, "mode": viewport.scaling_3d_mode, "inherited": inherited,
			"effects": [], "effect": effect, "next_effect_check": now + 250}
		_sync_effects(bindings[key], true)
		camera.compositor = installed
		viewport.scaling_3d_mode = Viewport.SCALING_3D_MODE_METALFX_TEMPORAL
	for key in bindings.keys():
		if not active.has(key):
			_restore(bindings[key])
			bindings.erase(key)

func _exit_tree() -> void:
	for binding in bindings.values():
		_restore(binding)
	bindings.clear()
	_restore_source_resolution()

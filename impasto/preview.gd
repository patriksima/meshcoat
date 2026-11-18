extends Node3D

var painted: StandardMaterial3D
var tree: Node3D
var camera: Camera3D

func _ready() -> void:
	var environment := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color("252d32")
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color("b4c7d0")
	env.ambient_light_energy = 0.25
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	environment.environment = env
	add_child(environment)
	var key := DirectionalLight3D.new()
	key.rotation_degrees = Vector3(-48, -38, 0)
	key.light_energy = 0.85
	key.light_color = Color("ffe6bb")
	key.shadow_enabled = true
	add_child(key)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-25, 135, 0)
	fill.light_energy = 0.25
	fill.light_color = Color("c6dcf0")
	add_child(fill)
	painted = StandardMaterial3D.new()
	painted.albedo_texture = load("res://height-demo/asset_albedo.png")
	painted.normal_enabled = true
	painted.normal_texture = load("res://height-demo/asset_normal.png")
	painted.normal_scale = 1.0
	painted.roughness = 1.0
	painted.roughness_texture = load("res://height-demo/asset_roughness.png")
	painted.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
	painted.metallic = 0.0
	painted.metallic_specular = 0.25
	painted.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	if not FileAccess.file_exists("res://ImpastoHeight.tres"):
		ResourceSaver.save(painted, "res://ImpastoHeight.tres")
	tree = load("res://models/test_tree.glb").instantiate()
	add_child(tree)
	apply_material(tree)
	camera = Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 5.0
	camera.position = Vector3(5, 8.5, 7)
	add_child(camera)
	camera.look_at(Vector3(0, 1.95, 0))
	camera.current = true
	var ground := MeshInstance3D.new()
	ground.mesh = PlaneMesh.new()
	ground.mesh.size = Vector2(200, 200)
	var ground_material := StandardMaterial3D.new()
	ground_material.albedo_color = Color("1f2826")
	ground_material.roughness = 1
	ground.material_override = ground_material
	ground.position.y = -0.025
	add_child(ground)
	var layer := CanvasLayer.new()
	add_child(layer)
	var title := Label.new()
	title.text = "MESHCOAT / SCULPTED IMPASTO"
	title.position = Vector2(44, 34)
	title.add_theme_font_size_override("font_size", 25)
	title.modulate = Color("e5e0cd")
	layer.add_child(title)
	var caption := Label.new()
	caption.text = "Authored height16  ·  normals from retained height  ·  Godot 4\nN: toggle relief    A/D: turn model    Esc: close"
	caption.position = Vector2(44, 920)
	caption.add_theme_font_size_override("font_size", 17)
	caption.modulate = Color("b9c4bd")
	layer.add_child(caption)
	if not "--qa-quit" in OS.get_cmdline_user_args():
		return
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	await get_tree().create_timer(1.5).timeout
	get_viewport().get_texture().get_image().save_png("res://height-evidence/godot-tree.png")
	painted.normal_enabled = false
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("res://height-evidence/godot-tree-flat.png")
	painted.normal_enabled = true
	print("MESHCOAT_GODOT_RENDER_OK normal=OpenGL roughness=R metallic=0")
	if "--qa-quit" in OS.get_cmdline_user_args():
		get_tree().quit()

func apply_material(node: Node) -> void:
	if node is MeshInstance3D:
		node.material_override = painted
	for child in node.get_children():
		apply_material(child)

func _unhandled_key_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		get_tree().quit()
	if event is InputEventKey and event.pressed:
		if event.keycode == KEY_N:
			painted.normal_enabled = not painted.normal_enabled
		elif event.keycode == KEY_A:
			tree.rotate_y(0.18)
		elif event.keycode == KEY_D:
			tree.rotate_y(-0.18)

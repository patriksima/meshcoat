"""Import and optionally render an MCP bundle in a dedicated disposable Godot project."""
import argparse,json,os,shutil,subprocess
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('--directory',type=Path,required=True,help='Dedicated test project directory containing the exported folder')
p.add_argument('--scene',required=True,help='Scene path relative to the test project, e.g. assets/painted_tree.tscn')
p.add_argument('--godot',default=shutil.which('godot') or shutil.which('godot4'))
p.add_argument('--render',action='store_true',help='Use an actual graphics window and save normal-on/off PNGs')
a=p.parse_args()
if not a.godot:p.error('Pass --godot /path/to/Godot executable')
root=a.directory.resolve();root.mkdir(parents=True,exist_ok=True)
scene=(root/a.scene).resolve()
if not scene.is_relative_to(root) or not scene.is_file():p.error('Scene must exist inside the dedicated directory')
marker=root/'.meshcoat-test-project'
if (root/'project.godot').exists() and not marker.exists():p.error('Refusing to modify an existing unrelated Godot project')
marker.touch()
(root/'project.godot').write_text('config_version=5\n[application]\nconfig/name="MeshCoat bundle validation"\n[display]\nwindow/size/viewport_width=1000\nwindow/size/viewport_height=900\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',encoding='utf-8')
script=r'''extends SceneTree

var meshes: Array[MeshInstance3D] = []
func _initialize() -> void:
	call_deferred("_run")

func _collect(node: Node) -> void:
	if node is MeshInstance3D:
		meshes.append(node)
	for child in node.get_children():
		_collect(child)

func _capture(file: String) -> void:
	await process_frame
	await RenderingServer.frame_post_draw
	await create_timer(0.5).timeout
	root.get_texture().get_image().save_png("res://" + file)

func _run() -> void:
	var scene: PackedScene = load(SCENE_PATH)
	if not scene:
		push_error("Failed to load exported scene")
		quit(2)
		return
	var model := scene.instantiate()
	root.add_child(model)
	await process_frame
	_collect(model)
	var manifest: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(MANIFEST_PATH))
	if meshes.size() != manifest.pieces.size():
		push_error("Unexpected imported mesh count")
		quit(3)
		return
	var bounds := AABB()
	for i in meshes.size():
		var mesh := meshes[i]
		var material := mesh.material_override as StandardMaterial3D
		if not material or not material.normal_enabled or not material.normal_texture or not material.roughness_texture:
			push_error("Missing painted PBR material on " + str(mesh.name))
			quit(4)
			return
		var box: AABB = mesh.global_transform * mesh.get_aabb()
		bounds = box if i == 0 else bounds.merge(box)
	if RENDER:
		var world := WorldEnvironment.new()
		world.environment = Environment.new()
		world.environment.background_mode = Environment.BG_COLOR
		world.environment.background_color = Color("242a2c")
		world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
		world.environment.ambient_light_color = Color("c7d3d6")
		world.environment.ambient_light_energy = 0.35
		root.add_child(world)
		var light := DirectionalLight3D.new()
		light.rotation_degrees = Vector3(-48, -38, 0)
		light.light_energy = 1.1
		light.light_color = Color("ffe6c2")
		root.add_child(light)
		var fill := DirectionalLight3D.new()
		fill.rotation_degrees = Vector3(-22, 135, 0)
		fill.light_energy = 0.35
		fill.light_color = Color("c7def5")
		root.add_child(fill)
		var camera := Camera3D.new()
		camera.projection = Camera3D.PROJECTION_ORTHOGONAL
		camera.size = max(bounds.size.y, bounds.size.x) * 1.35
		camera.near = 0.01
		camera.far = 1000
		camera.position = bounds.get_center() + Vector3(1, 0.65, 1.4).normalized() * bounds.size.length() * 2.5
		root.add_child(camera)
		camera.look_at(bounds.get_center())
		camera.current = true
		await _capture("godot-material.png")
		for mesh in meshes:
			(mesh.material_override as StandardMaterial3D).normal_enabled = false
		await _capture("godot-flat.png")
	print("MESHCOAT_BUNDLE_VALIDATED meshes=", meshes.size(), " rendered=", RENDER)
	quit(0)
'''
script=script.replace('SCENE_PATH',json.dumps('res://'+scene.relative_to(root).as_posix())).replace('MANIFEST_PATH',json.dumps('res://'+scene.relative_to(root).with_name(scene.stem+'_manifest.json').as_posix())).replace('RENDER','true' if a.render else 'false')
(root/'_meshcoat_verify.gd').write_text(script,encoding='utf-8')
profile=root/'test-profile';profile.mkdir(exist_ok=True)
env={**os.environ,'APPDATA':str(profile)}
logs={}
for mode,flags in [('import',([] if a.render else ['--headless'])+['--editor','--import']),('verify',([] if a.render else ['--headless'])+['--script','res://_meshcoat_verify.gd'])]:
    run=subprocess.run([a.godot,'--language','en','--path',str(root),*flags],env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
    log=run.stdout+run.stderr;(root/('godot-'+mode+'.log')).write_text(log,encoding='utf-8');logs[mode]={'exit':run.returncode,'output':log}
    print(mode,run.returncode,log[-2500:])
    if run.returncode or 'SCRIPT ERROR' in log or 'ERROR:' in log:raise SystemExit(1)
if a.render:
    import numpy as np
    from PIL import Image
    lit=np.asarray(Image.open(root/'godot-material.png')).astype(float)
    flat=np.asarray(Image.open(root/'godot-flat.png')).astype(float)
    delta=abs(lit-flat)
    logs['normalReliefComparison']={'meanAbsolutePixelDifference':float(delta.mean()),'changedPixelFraction':float(np.any(delta[:,:,:3]>2,axis=2).mean())}
    assert np.any(delta>2),'Rendered normals did not affect the image'
(root/'godot-validation.json').write_text(json.dumps(logs,indent=2),encoding='utf-8')

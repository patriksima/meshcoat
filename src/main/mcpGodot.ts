import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'

interface PieceExport {
  index: number
  name: string
  maps: { channel: string; dataUrl: string }[]
}

/** Relative resource paths keep the entire exported folder movable inside res://. */
export async function writeGodotBundle(
  directory: string,
  stem: string,
  modelPath: string,
  pieces: PieceExport[],
  overwrite: boolean
): Promise<unknown> {
  if (extname(modelPath).toLowerCase() !== '.glb') {
    throw new Error(
      'Portable Godot bundle requires a self-contained GLB source. Use texture export for GLTF/OBJ.'
    )
  }
  const dir = resolve(directory),
    files = new Map<string, Buffer | string>(),
    assignments: { index: number; name: string; material: string; maps: Record<string, string> }[] =
      []
  files.set(`${stem}.glb`, await readFile(modelPath))
  for (const piece of pieces) {
    const prefix =
      pieces.length === 1 ? stem : `${stem}_piece${String(piece.index).padStart(2, '0')}`
    const maps: Record<string, string> = {}
    for (const map of piece.maps) {
      if (
        !['albedo', 'normal', 'roughness', 'height', 'metalness'].includes(map.channel) ||
        !map.dataUrl.startsWith('data:image/png;base64,')
      ) {
        throw new Error('Invalid map from renderer')
      }
      const name = `${prefix}_${map.channel}.png`
      maps[map.channel] = name
      files.set(name, Buffer.from(map.dataUrl.split(',')[1], 'base64'))
    }
    const material = `${prefix}.tres`,
      channels = Object.keys(maps)
    const ext = channels
      .map((c, i) => `[ext_resource type="Texture2D" path="./${maps[c]}" id="${i + 1}"]`)
      .join('\n')
    const ref = (c: string): string => `ExtResource("${channels.indexOf(c) + 1}")`
    let resource = `[gd_resource type="StandardMaterial3D" load_steps=${channels.length + 1} format=3]\n\n${ext}\n\n[resource]\nresource_name = ${JSON.stringify(piece.name)}\nalbedo_texture = ${ref('albedo')}\nnormal_enabled = true\nnormal_scale = 1.0\nnormal_texture = ${ref('normal')}\nroughness = 1.0\nroughness_texture = ${ref('roughness')}\nroughness_texture_channel = 0\nmetallic_specular = 0.25\n`
    resource += maps.metalness
      ? `metallic = 1.0\nmetallic_texture = ${ref('metalness')}\nmetallic_texture_channel = 0\n`
      : 'metallic = 0.0\n'
    if (maps.height) {
      resource += `metadata/meshcoat_height_texture = ${ref('height')}\nmetadata/meshcoat_height_mapping = "(sample16-32768)/32767 model units; no geometry displacement"\n`
    }
    files.set(material, resource)
    assignments.push({ index: piece.index, name: piece.name, material, maps })
  }
  const script = `@tool
extends Node3D

@export var source_model: PackedScene
@export var paint_materials: Array[Material] = []
@export var piece_names: PackedStringArray = []

func _ready() -> void:
\tif not source_model or get_node_or_null("PaintedModel"):
\t\treturn
\tvar model := source_model.instantiate()
\tmodel.name = "PaintedModel"
\tadd_child(model)
\tvar matched: Array[String] = []
\t_apply(model, matched)
\tfor piece in piece_names:
\t\tif not piece in matched:
\t\t\tpush_error("MeshCoat: material was not assigned to mesh: " + piece)

func _apply(node: Node, matched: Array[String]) -> void:
\tif node is MeshInstance3D:
\t\tvar index := piece_names.find(str(node.name))
\t\tif index >= 0 and index < paint_materials.size():
\t\t\tnode.material_override = paint_materials[index]
\t\t\tmatched.append(str(node.name))
\tfor child in node.get_children():
\t\t_apply(child, matched)
`
  files.set(`${stem}_materials.gd`, script)
  const ext = assignments
    .map((a, i) => `[ext_resource type="Material" path="./${a.material}" id="m${i}"]`)
    .join('\n')
  files.set(
    `${stem}.tscn`,
    `[gd_scene load_steps=${assignments.length + 3} format=3]\n\n[ext_resource type="Script" path="./${stem}_materials.gd" id="script"]\n[ext_resource type="PackedScene" path="./${stem}.glb" id="model"]\n${ext}\n\n[node name="${stem}" type="Node3D"]\nscript = ExtResource("script")\nsource_model = ExtResource("model")\npaint_materials = Array[Material]([${assignments.map((_, i) => `ExtResource("m${i}")`).join(', ')}])\npiece_names = PackedStringArray(${assignments.map((a) => JSON.stringify(a.name)).join(', ')})\n`
  )
  const manifest = {
    format: 'meshcoat-godot-1',
    normal: 'OpenGL Y+',
    heightEncoding: 'PNG16 linear; (sample-32768)/32767 model units',
    scene: `${stem}.tscn`,
    sourceModel: `${stem}.glb`,
    pieces: assignments,
    limitations: [
      'Height is preserved as a source PNG16; material relief uses the derived normal map, no geometry displacement.',
      'Materials match imported mesh node names; unmatched names produce a Godot error.',
      'No claim of complete surface coverage: inspect the model from several views before production use.'
    ]
  }
  files.set(`${stem}_manifest.json`, JSON.stringify(manifest, null, 2))
  files.set(
    `${stem}_README.txt`,
    `Copy this whole folder anywhere inside your Godot 4 project, then instance ${stem}.tscn.\nThe @tool script assigns the per-piece materials in editor and at runtime.\nNormal maps are OpenGL Y+; do not invert Y. Matte roughness is taken from the painted maps.\nHeight PNG is genuine 16-bit source data. The StandardMaterial3D uses its derived normals, not displacement.\nMesh names must match; the generated script reports unmatched names.\n`
  )
  // Preflight the entire bundle before writing any output. Never replace user files by default.
  for (const name of files.keys()) {
    try {
      await stat(join(dir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    if (!overwrite) {
      throw new Error(`File exists; choose another directory/stem or set overwrite=true: ${name}`)
    }
  }
  await mkdir(dir, { recursive: true })
  for (const [name, content] of files) {
    await writeFile(join(dir, name), content, { flag: overwrite ? 'w' : 'wx' })
  }
  return {
    directory: dir,
    scene: join(dir, `${stem}.tscn`),
    manifest: join(dir, `${stem}_manifest.json`),
    files: [...files.keys()],
    pieces: assignments,
    validation:
      'Files exported; this call does not launch Godot or claim that its importer has been tested.'
  }
}

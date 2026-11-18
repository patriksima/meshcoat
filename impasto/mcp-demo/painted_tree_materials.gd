@tool
extends Node3D

@export var source_model: PackedScene
@export var paint_materials: Array[Material] = []
@export var piece_names: PackedStringArray = []

func _ready() -> void:
	if not source_model or get_node_or_null("PaintedModel"):
		return
	var model := source_model.instantiate()
	model.name = "PaintedModel"
	add_child(model)
	var matched: Array[String] = []
	_apply(model, matched)
	for piece in piece_names:
		if not piece in matched:
			push_error("MeshCoat: material was not assigned to mesh: " + piece)

func _apply(node: Node, matched: Array[String]) -> void:
	if node is MeshInstance3D:
		var index := piece_names.find(str(node.name))
		if index >= 0 and index < paint_materials.size():
			node.material_override = paint_materials[index]
			matched.append(str(node.name))
	for child in node.get_children():
		_apply(child, matched)

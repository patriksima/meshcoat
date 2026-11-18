Copy this whole folder anywhere inside your Godot 4 project, then instance painted_tree.tscn.
The @tool script assigns the per-piece materials in editor and at runtime.
Normal maps are OpenGL Y+; do not invert Y. Matte roughness is taken from the painted maps.
Height PNG is genuine 16-bit source data. The StandardMaterial3D uses its derived normals, not displacement.
Mesh names must match; the generated script reports unmatched names.

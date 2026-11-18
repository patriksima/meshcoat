from pathlib import Path
import shutil,json
from PIL import Image
import numpy as np
root=Path(__file__).resolve().parents[1]/'impasto'
dest=root/'height-demo';dest.mkdir(exist_ok=True)
for channel in ['albedo','normal','roughness','height']:
    shutil.copyfile(root/'height-evidence'/f'tree_{channel}.png',dest/f'asset_{channel}.png')
values=np.array(Image.open(dest/'asset_height.png')).astype(np.float32)
preview=np.round((values-32768)/max(float(values.max()-32768),1)*255).clip(0,255).astype('uint8')
Image.fromarray(preview).save(dest/'height-preview-CONTRAST.png')
(dest/'height-mapping.json').write_text(json.dumps({'encoding':'16-bit unsigned grayscale PNG, linear',
    'zero':32768,'world_height':'(sample_uint16 - 32768) / 32767', 'units':'model/world units',
    'blend':'max/min envelope per layer, additive height offsets between layers',
    'preview':'height-preview-CONTRAST.png is contrast stretched for viewing only; asset_height.png is authoritative'},indent=2))
p=root/'preview.gd';s=p.read_text(encoding='utf-8')
s=s.replace('res://textures/asset_','res://height-demo/asset_').replace('res://Impasto.tres','res://ImpastoHeight.tres')
s=s.replace('MESHCOAT / IMPASTO STUDY','MESHCOAT / SCULPTED IMPASTO').replace('MeshCoat brush strokes  ·  Godot 4  ·  matte PBR','Authored height16  ·  normals from retained height  ·  Godot 4')
s=s.replace('res://evidence/06-tree-godot.png','res://height-evidence/godot-tree.png').replace('res://evidence/07-tree-godot-flat.png','res://height-evidence/godot-tree-flat.png')
p.write_text(s,encoding='utf-8')
print(dest)

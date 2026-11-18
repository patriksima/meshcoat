"""Quantitative checks on real GPU exports, independent of the paint implementation."""
import json
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'impasto'
evidence = root / 'evidence'
image = lambda name: np.array(Image.open(evidence / name).convert('RGBA'))
report = {}
flat = image('relief-flat_albedo.png')
report['colorIndependentOfRelief'] = all(np.array_equal(flat, image('relief-' + label + '_albedo.png')) for label in ['low', 'high'])
assert report['colorIndependentOfRelief']
energies = {}
for label in ['flat', 'low', 'high']:
    data = image('relief-' + label + '_normal.png')
    h, w = data.shape[:2]
    y, x = np.mgrid[:h, :w]
    u, v = (x + .5) / w, 1 - (y + .5) / h
    mask = (((u > .06) & (u < .44)) | ((u > .56) & (u < .94))) & (v > .06) & (v < .94)
    normal = data[mask, :3].astype(float) / 255 * 2 - 1
    energies[label] = float(np.sqrt((normal[:, :2] ** 2).mean()))
report['normalXYrmsInsideUvIslands'] = energies
assert energies['flat'] < .01 and energies['flat'] < energies['low'] < energies['high']

# Known linear ramp: rising height in +Y must encode a -Y normal (OpenGL Y+).
ramp = image('opengl-ramp_normal.png')[512, 256, :3]
report['openglRampNormalRgb'] = ramp.tolist()
assert 123 <= ramp[0] <= 130 and ramp[1] < 127 and ramp[2] > 245

def sample(data, u, v):
    x, y = u * (data.shape[1]-1), (1-v) * (data.shape[0]-1)
    i, j = int(x), int(y); fx, fy = x-i, y-j
    return (data[j,i]*(1-fx)+data[j,i+1]*fx)*(1-fy)+(data[j+1,i]*(1-fx)+data[j+1,i+1]*fx)*fy

albedo = image('seam_albedo.png').astype(float)
normals = image('seam_normal.png')[:, :, :3].astype(float)/255*2-1
color_errors, angles = [], []
for world_y in np.linspace(-.20, .20, 200):
    # Two nearby physical points on opposite sides of the seam. The second
    # island is rotated 90 degrees, so compare normals in WORLD space.
    left_uv = (.45-.001*.4, .5+world_y*.45)
    right_uv = (.75+world_y*.2, .95-.001*.9)
    left, right = sample(normals, *left_uv), sample(normals, *right_uv)
    right = np.array([-right[1], right[0], right[2]])
    angles.append(float(np.degrees(np.arccos(np.clip(left@right/np.linalg.norm(left)/np.linalg.norm(right), -1, 1)))))
    color_errors.append(float(abs(sample(albedo, *left_uv)-sample(albedo, *right_uv)).max()))
report['rotatedUvSeam'] = {'meanAlbedoError8bit': float(np.mean(color_errors)),
    'maxAlbedoError8bit': float(np.max(color_errors)), 'meanWorldNormalAngleDegrees': float(np.mean(angles)),
    'maxWorldNormalAngleDegrees': float(np.max(angles)),
    'note': '1024px bilinear samples at +/-0.001 world units; not an exact pixel match or arbitrary-mesh guarantee'}
assert np.mean(color_errors) < 3 and np.mean(angles) < 8

orm = np.array(Image.open(root / 'textures/asset_orm.png').convert('RGB'))
roughness = np.array(Image.open(root / 'textures/asset_roughness.png').convert('RGB'))
report['ormMatchesRoughness'] = bool(np.array_equal(orm[:,:,1], roughness[:,:,0]))
report['ormAoIsWhite'] = bool(np.all(orm[:,:,0] == 255))
assert report['ormMatchesRoughness'] and report['ormAoIsWhite']
report['wizardMatchesDirectExport'] = {}
for source, final in [('BaseColor','albedo'),('Normal','normal'),('Roughness','roughness')]:
    a = image('wizard-export/asset_'+source+'.png')
    b = np.array(Image.open(root / ('textures/asset_'+final+'.png')).convert('RGBA'))
    report['wizardMatchesDirectExport'][final] = bool(np.array_equal(a,b))
assert all(report['wizardMatchesDirectExport'].values())
(evidence / 'export-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))

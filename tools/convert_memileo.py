"""Convert local Krita RGBA tips to MeshCoat coverage + estimated-relief tips.

No Krita engine emulation and no claim of recovered physical height. Source RGB
contains baked illumination. R stores a luminance-derived relief proxy, alpha
stores coverage. The fork differentiates R*alpha, without tinting the paint.
Requires Python 3 and Pillow; the source bundle is never modified.
"""
import argparse
import base64
import io
import json
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageOps, PngImagePlugin

PngImagePlugin.MAX_TEXT_CHUNK = PngImagePlugin.MAX_TEXT_MEMORY = 256 * 1024 * 1024


def gih_frames(data):
    title, header, data = data.split(b'\n', 2)
    frames = []
    offset = 0
    while offset < len(data):
        size, version, w, h, channels, magic, spacing = struct.unpack_from('>7I', data, offset)
        if version != 2 or magic != 0x47494D50 or channels != 4:
            raise ValueError('Expected GIMP v2 RGBA brush')
        start = offset + size
        end = start + w * h * channels
        if end > len(data):
            raise ValueError('Truncated GIH frame')
        frames.append(Image.frombytes('RGBA', (w, h), data[start:end]))
        offset = end
    return title.decode(), header.decode(), frames


def png_url(image):
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def convert(bundle, target):
    target.mkdir(parents=True, exist_ok=True)
    inventory = {'source': bundle.name, 'brushes': [], 'presets': [], 'patterns': []}
    pack = {'fileName': 'MeshCoat Impasto (memileo)', 'packName': 'MeshCoat Impasto (memileo)', 'brushes': []}
    previews = []
    with zipfile.ZipFile(bundle) as archive:
        inventory['metadata'] = archive.read('meta.xml').decode(errors='replace')
        for name in archive.namelist():
            if name.endswith('.kpp'):
                image = Image.open(io.BytesIO(archive.read(name)))
                # Krita embeds binary MD5 bytes in text; strip XML-illegal controls.
                xml = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', image.info['preset'])
                root = ET.fromstring(xml)
                params = {p.attrib['name']: p.text for p in root.iter('param')}
                inventory['presets'].append({'file': name, 'engine': root.attrib.get('paintopid'),
                    'parameters': {k: v for k, v in params.items() if not v or len(v) < 10000}})
            elif name.startswith('patterns/'):
                image = Image.open(io.BytesIO(archive.read(name)))
                inventory['patterns'].append({'file': name, 'mode': image.mode, 'size': image.size,
                    'role': 'Krita pattern/texture, not a calibrated physical height field'})
            elif name.endswith('.gih'):
                title, header, frames = gih_frames(archive.read(name))
                inventory['brushes'].append({'file': name, 'header': header, 'frames': len(frames),
                    'firstSize': frames[0].size, 'channels': 'RGBA; rotating baked light, not height'})
                # H has the clearest knife edge/grooves; A supplies a softer ridge variant.
                if 'PHOTO-H_' in name:
                    label, indices = 'Knife ridges', [0, 1, 2]
                elif 'PHOTO-A_' in name:
                    label, indices = 'Wavy bristles', [0, 1, 2]
                elif '_J_26' in name:
                    label, indices = 'Flat bristles', [0, 3, 6]
                else:
                    continue
                for variant, index in enumerate(indices):
                    source = frames[index]
                    alpha = source.getchannel('A')
                    luma = ImageOps.grayscale(source).filter(ImageFilter.GaussianBlur(0.6))
                    luma = ImageOps.autocontrast(luma, cutoff=1)
                    # Keep a broad raised bed and the source's internal ridge detail.
                    relief = luma.point(lambda p: round(65 + p * 0.70))
                    tip = Image.merge('RGBA', (relief, relief, relief, alpha))
                    # Preserve aspect ratio in the square dab domain, with a transparent border.
                    side = max(tip.size) + 8
                    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
                    square.paste(tip, ((side-tip.width)//2, (side-tip.height)//2))
                    # Source grooves run vertically; MeshCoat follows movement with local X.
                    square = square.transpose(Image.Transpose.ROTATE_90)
                    filename = f'{label.lower().replace(" ", "-")}-{variant+1}.png'
                    square.save(target / filename)
                    pack['brushes'].append({'id': f'impasto-{filename}', 'name': f'{label} {variant+1}',
                        'width': side, 'height': side, 'spacing': 0.24, 'diameter': side,
                        'packName': pack['packName'], 'dataUrl': png_url(square),
                        'impasto': True, 'sourceFrame': index, 'sourceBrush': title})
                    previews.append((label + f' {variant+1}', source, square))
    (target / 'impasto-impasto.json').write_text(json.dumps(pack, indent=2), encoding='utf-8')
    (target / 'bundle-inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    sheet = Image.new('RGB', (960, 720), '#34373a')
    draw = ImageDraw.Draw(sheet)
    for i, (label, source, tip) in enumerate(previews):
        x, y = (i % 3)*320, (i // 3)*240
        for j, image in enumerate([source, tip]):
            image = image.copy(); image.thumbnail((145, 185))
            sheet.paste(image, (x+10+j*155, y+25), image)
        draw.text((x+10, y+215), label+'  | source / relief+alpha', fill='white')
    sheet.save(target / 'conversion-preview.png')
    print(f'Converted {len(pack["brushes"])} tips; inspected {len(inventory["presets"])} presets')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--out', type=Path, default=Path('impasto/brushes'))
    args = parser.parse_args()
    convert(args.bundle, args.out)

# Scalar-height impasto brushes

This extension uses MeshCoat's existing surface projection, dab spacing, layer history,
lighting and exporters. It adds an authored height tip and a lossless scalar height channel.
It does not simulate pigment mixing, drying or paint fluid dynamics.

## Run and paint

```sh
npm ci --legacy-peer-deps
npm run build
npm run start:mcp
```

The automation launcher uses the separate `impasto-user-data` profile. For a built
Windows preview, use `Start-MeshCoat-Impasto.cmd` (no MCP) or `Start-MeshCoat-MCP.cmd`.
The application name and upstream package metadata remain MeshCoat.

1. Open a UV-unwrapped GLB, or `impasto/height_tree.meshcoat`.
2. Select **Library > MeshCoat Sculpted Impasto > MeshCoat Sculpt 1** (also 2/3).
3. Choose a color using the wheel. Set radius, spacing, direction following and jitter.
4. Adjust **Paint height (model units)** independently of color. Start around
   `0.004-0.025` for the included model. Negative values carve a groove.
5. Stamps form a maximum/minimum envelope within a layer. Separate paint layers add
   their heights; opacity scales each layer's contribution. Undo/redo restores the data.
6. **Height** display amplifies the field for inspection; it does not alter the export.
7. **Ctrl+E > Export Height16 PNG (native, per piece)** exports true grayscale PNG16.
   The same dialog exports albedo, OpenGL normals, roughness and ORM.
   MCP can export a complete multi-piece [Godot bundle](MCP.md).

## Data and examples

- `impasto/authored-brush/`: three original analytic sculpts, alpha/height16/packed/preview
  PNGs and a brush pack. Generator: `tools/make_authored_brush.py` (Python, NumPy, Pillow).
  The tips contain authored scalar height, not brightness recovered from a lit image.
- `impasto/models/`: procedural test tree and coplanar panel with a rotated UV island.
  These are synthetic fixtures, not third-party game assets.
- `impasto/height_tree.meshcoat`, `impasto/height_panel.meshcoat`: editable examples.
- `impasto/height-demo/`: albedo, normal, roughness and retained height maps.
- `impasto/project.godot`: standalone material preview. No external game project is needed.
- `tools/convert_memileo.py`: optional Krita bundle conversion experiment; see
  `impasto/brushes/LICENSE.md` for the separately licensed derived resources.
  Those older tips estimate relief from images and do not supply real stroke height.

Height is a signed scalar packed into RG bytes of a linear RGBA8 render target:
`height = (sample16 - 32768) / 32767` in model units. Zero is 32768; storage spans
approximately -1 to +1 and clamps beyond that range. Project snapshots preserve both
bytes; the PNG16 exporter never routes through an 8-bit canvas. Schema version is 6.
Normals are derived from the composited height using the world/UV metric.

## Validation and limits

```sh
npm test
npm run test:mcp
node tools/height-qa.cjs
python tools/verify_height.py
```

The MCP integration test launches the real compiled Electron application with isolated
temporary profiles. It checks painting, precision, undo/redo, save/reload, images,
overwrite protection and opt-in behavior. Results live under ignored `work/`.
Height QA exercises intensity independence, layer opacity/merge/erase and one rotated UV seam.
Finite texture resolution still produces seam differences; arbitrary UV layouts are not guaranteed.

Height-based normals do not reconstruct legacy normal-only strokes. Begin a height
workflow on a clean model or height-enabled project. The Godot material uses normal
relief; it does not displace geometry or change silhouettes. Tablet hardware, mirrored
UVs, complex masks, arbitrary PNG16 import, resolution changes and every export variant
have not been fully verified. Color filters and stencil/gradient do not author new height.

The original sculpt assets have permissive redistribution terms in their README.
MeshCoat code remains GPL-3.0-or-later. The optional memileo-derived pack has its own
CC BY-SA attribution; it is not the source of the authored scalar-height sculpts.

See [executed validation](VALIDATION.md) and [performance notes](PERFORMANCE.md).
The multi-view MCP example is `impasto/mcp_tree.meshcoat`; its portable Godot
folder is `impasto/mcp-demo/`.

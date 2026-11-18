# Local MCP painting interface

The stdio server uses the official Model Context Protocol SDK. It controls the running
MeshCoat application through an opt-in authenticated loopback bridge. Strokes use the
same pointer, surface projection, spacing, layers and undo engine as manual painting.

## Start and connect

```sh
npm ci --legacy-peer-deps
npm run build
npm run start:mcp
```

On Windows with an unpacked build, `Start-MeshCoat-MCP.cmd` starts the same bridge.
Normal launches do not enable automation. The MCP launcher stores its settings in
`impasto-user-data/`, separate from the regular application profile.

Configure an MCP client to launch Node directly, using an absolute path appropriate
to the checkout. Example client JSON (replace `/absolute/path/meshcoat`):

```json
{
  "mcpServers": {
    "meshcoat": {
      "command": "node",
      "args": ["/absolute/path/meshcoat/mcp/server.mjs"]
    }
  }
}
```

Use a Node version supporting `fetch` and `AbortSignal.timeout` (Node 22 is tested).
Do not use `npm run mcp` as a client's stdio command: npm may print non-protocol text.
For another app profile, pass `--endpoint /path/to/profile/mcp-bridge.json` to the server
or set `MESHCOAT_MCP_ENDPOINT`. Set `MESHCOAT_USER_DATA` when launching the app to choose
the corresponding profile. Start only one app instance per automation profile.

The bridge listens on `127.0.0.1` at a random port, requires a random bearer token,
rejects browser Origin requests and serializes operations. Its endpoint file is local
profile state, not a deliverable. It exposes fixed commands, not arbitrary JavaScript
or shell execution. It is a trusted local automation interface, not a remote multi-user service.

## Feedback loop for effective painting

1. `meshcoat_open` imports a model or project. `meshcoat_status` reports its pieces,
   world/projected bounds, camera, layer state, enabled channels and usable brush radius.
2. `meshcoat_camera` frames the model or one piece from front/back/left/right/top/isometric,
   changes zoom or sets exact world-space position/target and lighting.
3. `meshcoat_screenshot` returns an actual fresh viewport **MCP image**, plus matching camera,
   mode and projected piece bounds. Clean captures temporarily hide cursor/grid/selection
   overlays and restore the previous UI. Modes: `material`, `baseColor`, `normal`,
   `roughness`, `height`. Height view is amplified for readability, not quantitative.
4. Use `meshcoat_probe` at candidate points to verify the visible surface, piece, world
   normal, UV and retained height. Screen bounds are aiming aids and can include occluded areas.
5. Select a preset via `meshcoat_brushes` and `meshcoat_set_brush`. Paint a few strokes.
   `meshcoat_stroke` reports path samples, surface hits/misses, hit pieces and engine writes.
   These are operation diagnostics, not an artistic quality score or a changed-texel count.
6. Inspect the lit screenshot again. `meshcoat_inspect` reads composited GPU data over
   UV-covered texels: height range, distinct values, coverage, clipping, mean roughness
   and metalness, plus selection warnings. A raised-texel fraction is not proof of a
   finished paint job. Rotate and inspect occluded/back-facing surfaces before export.
7. Correct with `meshcoat_history`, `meshcoat_add_layer` and further strokes. Save with
   `meshcoat_save_project`. Existing files require explicit `overwrite: true`.
8. `meshcoat_export_godot` exports **all** pieces, not just the active texture set.

Stroke points are normalized **within the returned viewport image**: x right, y down,
both 0..1. Start on a visible surface. One call is one undoable stroke; spacing remains
the brush engine's spacing. Pressure inputs can exercise the pen path, but do not validate
a physical tablet. `meshcoat_select_piece` selects the texture set for fill/layers/history;
it can focus and isolate that piece. `meshcoat_fill` fills enabled channels using the
current selection; use height 0 for a flat underpainting.

Example stroke arguments:

```json
{"points":[{"x":0.42,"y":0.47},{"x":0.57,"y":0.53}],"tool":"brush"}
```

## Godot output

`meshcoat_export` writes selected native-resolution maps for a specific piece.
`meshcoat_export_godot` requires a self-contained source **GLB** and writes a movable folder:

- GLB, native albedo/OpenGL-normal/roughness maps, optional metalness and genuine PNG16 height;
- a matte `StandardMaterial3D` per piece (roughness map, reduced dielectric specular);
- a ready `.tscn` and small `@tool` material assignment script, active in editor and runtime;
- a manifest describing piece/material mapping and physical height encoding.

Copy the entire folder anywhere inside a Godot 4 project and instance the `.tscn`.
Relative resource paths keep it movable. Imported mesh names must match; unmatched
names produce a Godot error rather than silently assigning the wrong material.
Godot normal maps use **OpenGL Y+**, without green-channel inversion. Height is preserved
as source data and referenced as material metadata; normal relief is enabled, geometry
displacement is not. The export tool reports file creation, not an unperformed Godot render.

## Reproducible checks

```sh
npm run build
npm run test:mcp
```

The integration test uses an official SDK client over stdio against the real compiled
Electron app. It checks 16 tools, raycasts/strokes, PNG16, exact undo/redo and project reload,
GPU measurements, image modes, Godot bundle generation, protected writes, rejected invalid
commands and disabled-by-default startup. Unique output directories under `work/` preserve
previous runs. No user or game project is modified.

For a reproducible multi-view painting pilot, run `node tools/mcp-paint-demo.mjs`.
See [validation images and limits](VALIDATION.md) and [performance measurements](PERFORMANCE.md).

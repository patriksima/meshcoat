# Impasto performance

The prototype is GPU-heavy: every accepted dab projects the enabled channels,
dilates UV margins and composites the layer stack. The height workflow also derives
normals from the final scalar field. Texture area, layer count and dab spacing matter.
Changing height amplitude itself is not a useful performance control.

A redundant path has been removed: height strokes no longer paint a legacy normal
buffer or composite normal layers that the height-derived normal immediately replaces.
Derived normals remain available in the viewport, project channel list and exporters,
including when only Color and Height are enabled.

## Measured local comparison

Windows, GTX 1660 Ti, Electron WebGL2 through ANGLE/D3D11. Same synthetic coplanar
panel, viewport 1600x1000, original sculpt tip, Color/Roughness/Metalness/Height enabled.
Each row is a median of 32 warmed pointer-move samples during one continuous stroke.
A one-pixel synchronous GPU readback waits for completion; its synchronization overhead
is included. Scene rendering, per-stroke undo allocation and MCP round trips are excluded.
These are comparative paint-update latencies, **not application FPS or guarantees for other GPUs**.

| Texture | Paint layers | Before | After | GPU draw calls before / after |
| --- | ---: | ---: | ---: | ---: |
| 1024 | 1 | 4.2 ms | 3.8 ms | 36 / 29 |
| 1024 | 6 | 5.5 ms | 4.3 ms | 61 / 49 |
| 2048 | 1 | 9.8 ms | 7.9 ms | 36 / 29 |
| 2048 | 6 | 14.4 ms | 11.5 ms | 61 / 49 |

The 2048/six-layer case improved by about 20% in this run. The legacy normal-only
reference measured about 11.5 ms after the change; the extra height path is now close
to that reference on this fixture. Small-resolution timings are noisy and can vary with
GPU clocks and scheduling. Sixteen exported albedo/normal/roughness/height images from
the deterministic MCP panel regression were pixel-identical before and after optimization.

## Practical settings and reproduction

- Use 1K for rapid experiments and 2K when inspecting bristle detail. 4K was not benchmarked.
- Keep the layer stack modest; merge only when losing separate editability is acceptable.
- Very small spacing increases dab count. Start around 0.12-0.2 and inspect continuity.
- After a matte underpainting, Color + Height alone can avoid repainting unchanged scalar
  material channels. Normal output is still derived. Enable Roughness/Metalness again
  when strokes need to change those material properties.
- Avoid simultaneous GPU test/render processes when judging interactive responsiveness.
- AI painting also pays for tool calls, setting changes, history and screenshots. A scripted
  long stroke submits many updates in one request; its wall time is not a single-frame budget.
  Batch surface probes and inspect after small groups of strokes.

```sh
npm run build
node tools/benchmark-impasto.mjs
```

The benchmark launches an isolated profile and writes detailed samples into a unique
ignored `work/impasto-benchmark-*` directory. It never changes an existing project.
Future improvements could limit work to dirty texture regions or batch intermediate
composites. Those changes require separate UV-seam, layer and history validation.

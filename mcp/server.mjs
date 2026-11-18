/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain Node ESM. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const endpointIndex = process.argv.indexOf('--endpoint')
const endpointFile =
  endpointIndex >= 0
    ? resolve(process.argv[endpointIndex + 1])
    : process.env.MESHCOAT_MCP_ENDPOINT || resolve(root, 'impasto-user-data/mcp-bridge.json')
const server = new McpServer({ name: 'meshcoat', version: '0.1.0' })

async function invoke(command, args) {
  let endpoint
  try {
    endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  } catch {
    throw new Error(
      `MeshCoat MCP bridge is offline. Start npm run start:mcp first. Endpoint: ${endpointFile}`
    )
  }
  const url = new URL(endpoint.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/invoke') {
    throw new Error('Invalid local MeshCoat endpoint')
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(120000)
  })
  const result = await response.json()
  if (!response.ok || result.error) {
    throw new Error(result.error || `MeshCoat bridge HTTP ${response.status}`)
  }
  return result.result
}
function tool(name, command, description, inputSchema = {}, readOnly = false) {
  server.registerTool(
    name,
    { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: false } },
    async (args) => {
      try {
        const result = await invoke(command, args)
        if (command === 'screenshot') {
          return {
            content: [
              { type: 'image', data: result.image, mimeType: 'image/png' },
              {
                type: 'text',
                text: JSON.stringify({
                  width: result.width,
                  height: result.height,
                  coordinates: result.coordinates,
                  feedback: result.feedback
                })
              }
            ]
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
        }
      }
    }
  )
}
const path = z.string().min(1).max(4096)
const vector = z.tuple([
  z.number().min(-1e6).max(1e6),
  z.number().min(-1e6).max(1e6),
  z.number().min(-1e6).max(1e6)
])
const point = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  pressure: z.number().min(0).max(1).optional()
})

tool(
  'meshcoat_status',
  'status',
  'Inspect the live model, pieces, layers, brush, camera, viewport and unsaved work.',
  {},
  true
)
tool(
  'meshcoat_brushes',
  'brushes',
  'List installed brush presets, including which have real authored height.',
  {},
  true
)
tool(
  'meshcoat_open',
  'open',
  'Open a local GLB/GLTF/OBJ or .meshcoat project through the app. Unsaved paint is preserved unless allowDiscard is explicit.',
  {
    path,
    resolution: z
      .union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)])
      .default(1024),
    allowDiscard: z.boolean().default(false),
    modelPath: path.optional().describe('Optional relocated model path for a saved project')
  }
)
tool(
  'meshcoat_set_brush',
  'set_brush',
  'Choose a preset and material/stroke settings. Radius and height use model units; spacing is a fraction of radius.',
  {
    channels: z
      .array(z.enum(['baseColor', 'normal', 'roughness', 'metalness', 'height']))
      .min(1)
      .max(5)
      .optional(),
    preset: z.string().max(200).optional(),
    color: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .optional(),
    radius: z.number().positive().optional(),
    height: z.number().min(-0.06).max(0.06).optional(),
    normalStrength: z.number().min(-4).max(4).optional(),
    roughness: z.number().min(0).max(1).optional(),
    opacity: z.number().min(0).max(1).optional(),
    spacing: z.number().min(0.02).max(2).optional(),
    rotation: z.number().min(-360).max(360).optional(),
    followStroke: z.boolean().optional(),
    angleJitter: z.number().min(0).max(1).optional(),
    sizeJitter: z.number().min(0).max(1).optional()
  }
)
tool(
  'meshcoat_camera',
  'camera',
  'Frame the model, choose a cardinal/isometric view of the model or one piece, or set position/target. Inspect screenshot and probe before painting.',
  {
    zoom: z.number().min(0.4).max(3).optional(),
    lighting: z.enum(['neutral', 'flat', 'outdoor', 'warm', 'cool']).optional(),
    preset: z.enum(['front', 'back', 'left', 'right', 'top', 'isometric']).optional(),
    pieceIndex: z.number().int().nonnegative().optional(),
    frame: z.boolean().optional(),
    position: vector.optional(),
    target: vector.optional()
  }
)
tool(
  'meshcoat_probe',
  'probe',
  'Raycast one normalized viewport point or a batch of up to 128 points; return hit piece, world position, normal, face and UV. No painting.',
  {
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    points: z.array(point).min(1).max(128).optional()
  },
  true
)
tool(
  'meshcoat_stroke',
  'stroke',
  'Paint or erase through the existing surface/UV brush engine. Points are 0..1 in the viewport screenshot, not the full app window. Start on a visible surface. One call is one undoable stroke.',
  {
    points: z.array(point).min(1).max(256),
    tool: z.enum(['brush', 'eraser']).default('brush'),
    pressure: z.boolean().default(false)
  }
)
tool(
  'meshcoat_add_layer',
  'add_layer',
  'Add and select a paint layer. Height offsets of separate layers add together.',
  { name: z.string().min(1).max(120) }
)
tool(
  'meshcoat_fill',
  'fill',
  'Fill the active piece/selection with the currently enabled brush channels. Set brush height to 0 for a flat underpainting.'
)
tool(
  'meshcoat_history',
  'history',
  'Undo or redo one operation using the same project history as the UI.',
  { action: z.enum(['undo', 'redo']) }
)
tool(
  'meshcoat_save_project',
  'save_project',
  'Save the editable project, including lossless height, at an explicit local .meshcoat path. Existing files require overwrite=true.',
  {
    path,
    overwrite: z.boolean().default(false)
  }
)
tool(
  'meshcoat_export',
  'export',
  'Export native-resolution maps for one piece: albedo, OpenGL normal, roughness, genuine PNG16 height, ORM or metalness. Existing files require overwrite=true.',
  {
    directory: path,
    stem: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    pieceIndex: z.number().int().nonnegative().optional(),
    channels: z
      .array(z.enum(['albedo', 'normal', 'roughness', 'height', 'orm', 'metalness']))
      .min(1)
      .max(6)
      .optional(),
    overwrite: z.boolean().default(false)
  }
)
tool(
  'meshcoat_screenshot',
  'screenshot',
  'Return the actual lit viewport as an MCP image. Coordinates for probe/stroke are normalized to this image.',
  {
    mode: z.enum(['material', 'baseColor', 'normal', 'roughness', 'height']).optional(),
    clean: z.boolean().default(true)
  },
  true
)

tool(
  'meshcoat_inspect',
  'inspect',
  'Measure actual composited GPU data on UV-covered texels: physical height range/coverage/precision/clipping and matte roughness. Use after a few strokes; screenshot remains essential for artistic judgment.',
  { pieceIndex: z.number().int().nonnegative().optional() },
  true
)
tool(
  'meshcoat_select_piece',
  'select_piece',
  'Select a texture set for layers/fill/history. Optionally focus it and isolate/unisolate its display. Stroke raycasts still target visible surfaces.',
  {
    index: z.number().int().nonnegative(),
    focus: z.boolean().optional(),
    isolate: z.boolean().optional()
  }
)
tool(
  'meshcoat_export_godot',
  'export_godot',
  'Export ALL pieces of a GLB into a movable Godot 4 folder: GLB, native albedo/OpenGL-normal/roughness maps, retained PNG16 height, per-piece matte materials, ready .tscn and assignment/height manifest. Refuses overwrites by default. Does not launch Godot.',
  {
    directory: path,
    stem: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    overwrite: z.boolean().default(false)
  }
)

await server.connect(new StdioServerTransport())

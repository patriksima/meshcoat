/* eslint-disable @typescript-eslint/explicit-function-return-type, max-depth -- Standalone visual pilot. */
import { _electron as electron } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, mkdtemp, access, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'work'), { recursive: true })
const output = await mkdtemp(join(root, 'work/mcp-paint-'))
const profile = join(output, 'profile'),
  endpoint = join(profile, 'mcp-bridge.json')
const env = { ...process.env, MESHCOAT_MCP: '1', MESHCOAT_USER_DATA: profile }
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE
let app, client
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
let strokes = 0,
  misses = 0
try {
  app = await electron.launch({ args: [root], env, timeout: 60000 })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 1000 })
  for (let i = 0; ; i++) {
    try {
      await access(endpoint)
      break
    } catch {
      if (i > 300) {
        throw new Error('Bridge did not start')
      }
      await pause(100)
    }
  }
  client = new Client({ name: 'meshcoat-visual-pilot', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'mcp/server.mjs'), '--endpoint', endpoint],
      cwd: root
    })
  )
  async function call(name, args = {}) {
    const response = await client.callTool({ name: 'meshcoat_' + name, arguments: args })
    if (response.isError) {
      throw new Error(JSON.stringify(response.content))
    }
    return name === 'screenshot'
      ? response
      : JSON.parse(response.content.find((c) => c.type === 'text').text)
  }
  for (let i = 0; ; i++) {
    try {
      await call('status')
      break
    } catch (error) {
      if (i > 300) {
        throw error
      }
      await pause(100)
    }
  }
  await call('open', { path: join(root, 'impasto/models/test_tree.glb'), resolution: 2048 })
  const packs = await call('brushes'),
    preset = packs.find((p) => p.name === 'MeshCoat Sculpted Impasto').brushes[0].id
  await call('set_brush', { preset, color: '#526843', height: 0, roughness: 0.93, opacity: 1 })
  await call('fill')
  for (const view of ['front', 'right', 'back', 'left', 'top']) {
    const state = await call('camera', { preset: view, zoom: 1.22, lighting: 'neutral' })
    const bounds = state.scene.pieces[0].screenBounds,
      points = []
    const left = Math.max(0.02, bounds.left),
      right = Math.min(0.98, bounds.right),
      top = Math.max(0.02, bounds.top),
      bottom = Math.min(0.98, bounds.bottom)
    for (let j = 1; j < 24; j++) {
      for (let i = 1; i < 17; i++) {
        points.push({ x: left + ((right - left) * i) / 17, y: top + ((bottom - top) * j) / 24 })
      }
    }
    const hits = []
    for (let i = 0; i < points.length; i += 128) {
      const batch = points.slice(i, i + 128),
        response = await call('probe', { points: batch })
      response.samples.forEach((hit, j) => {
        if (hit.hit) {
          hits.push({ p: batch[j], hit })
        }
      })
    }
    await call('add_layer', { name: `Surface strokes ${view}` })
    let painted = 0
    for (let i = 0; i < hits.length; i++) {
      const { p, hit } = hits[i],
        isTrunk = hit.world[1] < 1.35
      // Keep more trunk samples because it is narrow; stagger the canopy rows.
      if (!isTrunk && i % 2) {
        continue
      }
      const n = hit.normal,
        light = Math.max(0, n[0] * 0.35 + n[1] * 0.75 + n[2] * 0.5)
      const variation = Math.sin(hit.world[0] * 6 + hit.world[1] * 5 + hit.world[2] * 7) * 0.05
      const level = Math.max(0, Math.min(3, Math.floor((light + variation) * 3)))
      const color = (
        isTrunk
          ? ['#6c4b33', '#865d3f', '#9d714c', '#ad8256']
          : ['#516847', '#60774b', '#738650', '#89965e']
      )[level]
      await call('set_brush', {
        color,
        radius: isTrunk ? 0.17 : 0.22,
        height: isTrunk ? 0.012 : 0.018,
        opacity: 0.88,
        spacing: 0.15,
        followStroke: true,
        angleJitter: 0.035,
        sizeJitter: 0.08,
        roughness: 0.9
      })
      const dx = isTrunk ? 0.001 : 0.022,
        dy = isTrunk ? -0.035 : -0.035
      const result = await call('stroke', {
        points: [
          { x: Math.max(0.001, p.x - dx), y: Math.min(0.999, p.y - dy) },
          p,
          { x: Math.min(0.999, p.x + dx), y: Math.max(0.001, p.y + dy) }
        ]
      })
      strokes++
      misses += result.feedback.misses
      if (result.painted) {
        painted++
      }
    }
    console.log(JSON.stringify({ view, candidates: hits.length, painted, strokes }))
  }
  await call('camera', { preset: 'isometric', zoom: 1.18, lighting: 'neutral' })
  for (const mode of ['material', 'baseColor', 'normal', 'height']) {
    const response = await call('screenshot', { mode })
    await writeFile(
      join(output, `${mode}.png`),
      Buffer.from(response.content.find((c) => c.type === 'image').data, 'base64')
    )
  }
  const measured = await call('inspect')
  await call('save_project', { path: join(output, 'painted_tree.meshcoat') })
  const bundle = await call('export_godot', {
    directory: join(output, 'godot/assets'),
    stem: 'painted_tree'
  })
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify({ strokes, misses, measured, bundle }, null, 2)
  )
  console.log(JSON.stringify({ output, strokes, measured }, null, 2))
} finally {
  if (client) {
    await client.close().catch(() => {})
  }
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {})
    await app.close().catch(() => {})
  }
}

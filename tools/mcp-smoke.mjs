/* eslint-disable @typescript-eslint/explicit-function-return-type, max-depth -- Standalone integration test. */
import { _electron as electron } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile, writeFile, mkdir, mkdtemp, access } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'work'), { recursive: true })
const output = await mkdtemp(join(root, 'work/mcp-test-'))
const profile = join(output, 'profile')
const endpointFile = join(profile, 'mcp-bridge.json')
const env = { ...process.env, MESHCOAT_MCP: '1', MESHCOAT_USER_DATA: profile }
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE
const errors = []
let app, client
const hash = (data) => createHash('sha256').update(data).digest('hex')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  app = await electron.launch({
    executablePath: process.env.MESHCOAT_TEST_EXECUTABLE,
    args: process.env.MESHCOAT_TEST_EXECUTABLE ? [] : [root],
    env,
    timeout: 60000
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  for (let i = 0; ; i++) {
    try {
      await access(endpointFile)
      break
    } catch {
      if (i > 300) {
        throw new Error('Bridge endpoint was not created')
      }
      await pause(100)
    }
  }
  console.log('Electron launched; connecting MCP')
  client = new Client({ name: 'meshcoat-integration-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'mcp/server.mjs'), '--endpoint', endpointFile],
      cwd: root
    })
  )
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 16)
  async function call(name, args = {}, expectError = false) {
    const result = await client.callTool({ name: 'meshcoat_' + name, arguments: args })
    if (expectError) {
      assert.equal(result.isError, true, JSON.stringify(result))
      return result
    }
    assert.ok(!result.isError, JSON.stringify(result))
    if (name === 'screenshot') {
      return result
    }
    return JSON.parse(result.content.find((c) => c.type === 'text').text)
  }
  for (let i = 0; ; i++) {
    const r = await client.callTool({ name: 'meshcoat_status', arguments: {} })
    if (!r.isError) {
      break
    }
    if (i > 300) {
      throw new Error(JSON.stringify(r))
    }
    await pause(100)
  }
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  assert.equal((await fetch(endpoint.url, { method: 'POST', body: '{}' })).status, 401)
  assert.equal(
    (
      await fetch(endpoint.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.token}`, Origin: 'https://example.com' },
        body: '{}'
      })
    ).status,
    401
  )
  assert.equal(
    (
      await fetch(endpoint.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ command: 'eval', args: {} })
      })
    ).status,
    400
  )

  console.log('MCP initialized; painting test panel')
  const model = join(root, 'impasto/models/seam_panel.glb')
  await call('open', { path: model, resolution: 1024 })
  await call('camera', { position: [0, 0, 3.3], target: [0, 0, 0] })
  const packs = await call('brushes')
  const preset = packs.find((p) => p.name === 'MeshCoat Sculpted Impasto').brushes[0]
  assert.equal(preset.height, true)
  await call('set_brush', {
    preset: preset.id,
    color: '#a58142',
    radius: 0.34,
    height: 0.03,
    opacity: 1,
    angleJitter: 0,
    sizeJitter: 0,
    followStroke: true
  })
  const probe = await call('probe', { x: 0.4, y: 0.5 })
  assert.ok(probe.world && probe.uv, 'Probe must hit the panel')
  assert.equal(
    (
      await call('probe', {
        points: [
          { x: 0.4, y: 0.5 },
          { x: 0, y: 0 }
        ]
      })
    ).samples[1].hit,
    false
  )
  const stroke = await call('stroke', {
    points: [
      { x: 0.35, y: 0.5 },
      { x: 0.65, y: 0.5 }
    ]
  })
  assert.equal(stroke.painted, true)
  assert.ok(stroke.feedback.surfaceHits > 0)
  assert.ok(stroke.feedback.changedPieces.includes(0))
  const measured = await call('inspect')
  assert.ok(measured.height.distinctValues > 256, JSON.stringify(measured))
  assert.ok(measured.height.nonzeroTexels > 0)
  assert.equal(measured.height.clippedTexels, 0)
  assert.equal(stroke.state.project.dirty, true)
  const directory = join(output, 'exports')
  async function exportMaps(stem) {
    return call('export', {
      directory,
      stem,
      channels: ['albedo', 'normal', 'roughness', 'height']
    })
  }
  const exported = await exportMaps('asset')
  assert.equal(exported.files.length, 4)
  const original = await readFile(join(directory, 'asset_height.png'))
  assert.equal(original[24], 16, 'Height must be PNG16')
  await call('export', { directory, stem: 'asset' }, true)
  assert.equal(hash(await readFile(join(directory, 'asset_height.png'))), hash(original))
  await call('open', { path: model }, true)
  await call('set_brush', { preset: 'missing-preset' }, true)
  await call('stroke', { points: [{ x: 2, y: 0.5 }] }, true)
  await call('history', { action: 'undo' })
  await exportMaps('undo')
  assert.notEqual(hash(await readFile(join(directory, 'undo_height.png'))), hash(original))
  await call('history', { action: 'redo' })
  await exportMaps('redo')
  assert.equal(hash(await readFile(join(directory, 'redo_height.png'))), hash(original))

  await call('add_layer', { name: 'MCP blue paint' })
  await call('set_brush', { color: '#427c91', height: 0.012 })
  assert.equal(
    (
      await call('stroke', {
        points: [
          { x: 0.5, y: 0.4 },
          { x: 0.5, y: 0.6 }
        ]
      })
    ).painted,
    true
  )
  await exportMaps('layered')
  const project = join(output, 'mcp-demo.meshcoat')
  const saved = await call('save_project', { path: project })
  assert.equal(saved.project.dirty, false)
  await call('save_project', { path: project }, true)
  await call('open', { path: project })
  await exportMaps('reload')
  assert.equal(
    hash(await readFile(join(directory, 'reload_height.png'))),
    hash(await readFile(join(directory, 'layered_height.png')))
  )
  await call('camera', { preset: 'front', lighting: 'neutral', zoom: 1.3 })
  await call('select_piece', { index: 0, isolate: false })
  const bundle = await call('export_godot', {
    directory: join(output, 'godot/assets'),
    stem: 'mcp_panel'
  })
  assert.equal(bundle.pieces.length, 1)
  await call('export_godot', { directory: join(output, 'godot/assets'), stem: 'mcp_panel' }, true)
  assert.ok(
    (await readFile(join(output, 'godot/assets/mcp_panel.tres'), 'utf8')).includes(
      'normal_enabled = true'
    )
  )
  for (const mode of ['baseColor', 'normal', 'roughness', 'height']) {
    const capture = await call('screenshot', { mode })
    const image = capture.content.find((c) => c.type === 'image')
    await writeFile(join(output, `viewport-${mode}.png`), Buffer.from(image.data, 'base64'))
    assert.equal(
      JSON.parse(capture.content.find((c) => c.type === 'text').text).feedback.viewMode,
      mode
    )
  }
  const screenshot = await call('screenshot', { mode: 'material' })
  const image = screenshot.content.find((c) => c.type === 'image')
  assert.equal(image.mimeType, 'image/png')
  await writeFile(join(output, 'viewport.png'), Buffer.from(image.data, 'base64'))
  await page.screenshot({ path: join(output, 'application.png') })
  // Two independent texture sets sharing source geometry must both be exported.
  const panel = await readFile(model),
    jsonLength = panel.readUInt32LE(12)
  const doc = JSON.parse(panel.subarray(20, 20 + jsonLength).toString('utf8'))
  const node = doc.nodes.find((n) => n.mesh !== undefined)
  doc.nodes = [
    { ...node, name: 'Panel_A', translation: [-1.2, 0, 0] },
    { ...node, name: 'Panel_B', translation: [1.2, 0, 0] }
  ]
  doc.scenes = [{ nodes: [0, 1] }]
  doc.scene = 0
  let json = Buffer.from(JSON.stringify(doc))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)])
  const tail = panel.subarray(20 + jsonLength),
    header = Buffer.alloc(20)
  header.write('glTF')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + json.length + tail.length, 8)
  header.writeUInt32LE(json.length, 12)
  header.write('JSON', 16)
  const multipartModel = join(output, 'multipart.glb')
  await writeFile(multipartModel, Buffer.concat([header, json, tail]))
  await call('open', { path: multipartModel, resolution: 512 })
  for (const index of [0, 1]) {
    await call('select_piece', { index, isolate: false })
    await call('set_brush', {
      preset: preset.id,
      color: index === 0 ? '#986e42' : '#5e8050',
      height: 0,
      roughness: 0.9
    })
    await call('fill')
  }
  const multiView = await call('camera', { preset: 'front' })
  const box = multiView.scene.pieces[1].screenBounds
  const center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
  assert.equal((await call('probe', center)).piece, 1)
  await call('set_brush', { height: 0.02, radius: 0.25 })
  await call('stroke', {
    points: [{ x: center.x - 0.03, y: center.y }, center, { x: center.x + 0.03, y: center.y }]
  })
  await call('set_brush', { channels: ['baseColor', 'height'], height: 0.01 })
  await call('stroke', {
    points: [
      { x: center.x, y: center.y - 0.03 },
      { x: center.x, y: center.y + 0.03 }
    ]
  })
  assert.ok((await call('status')).channels.includes('normal'))
  const beforeErase = (await call('probe', center)).sample.height
  assert.ok(beforeErase > 0)
  await call('set_brush', { channels: ['height'], opacity: 1, radius: 0.3 })
  assert.equal(
    (
      await call('stroke', {
        tool: 'eraser',
        points: [{ x: center.x - 0.01, y: center.y }, center, { x: center.x + 0.01, y: center.y }]
      })
    ).painted,
    true
  )
  const afterErase = (await call('probe', center)).sample.height
  assert.ok(afterErase < beforeErase)
  await call('history', { action: 'undo' })
  assert.equal((await call('probe', center)).sample.height, beforeErase)
  const multipartBundle = await call('export_godot', {
    directory: join(output, 'godot-multipart/assets'),
    stem: 'multipart'
  })
  assert.equal(multipartBundle.pieces.length, 2)
  assert.ok(multipartBundle.files.includes('multipart_piece00_albedo.png'))
  assert.ok(multipartBundle.files.includes('multipart_piece01_albedo.png'))
  await call('save_project', { path: join(output, 'multipart.meshcoat') })
  const status = await call('status')
  assert.deepEqual(errors, [])
  await client.close()
  client = undefined
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
  )
  await app.close()
  app = undefined
  for (let i = 0; i < 30; i++) {
    try {
      await access(endpointFile)
      await pause(100)
    } catch {
      break
    }
  }
  await assert.rejects(access(endpointFile), 'Endpoint must disappear on close')

  // A normal launch must not expose automation or create the bridge file.
  console.log('Painting/export/feedback passed; checking disabled startup')
  const disabledProfile = join(output, 'disabled-profile')
  app = await electron.launch({
    executablePath: process.env.MESHCOAT_TEST_EXECUTABLE,
    args: process.env.MESHCOAT_TEST_EXECUTABLE ? [] : [root],
    env: { ...env, MESHCOAT_MCP: '0', MESHCOAT_USER_DATA: disabledProfile },
    timeout: 60000
  })
  const disabledPage = await app.firstWindow()
  await disabledPage.waitForFunction(() => !!window.api)
  assert.equal(await disabledPage.evaluate(() => window.api.automationEnabled()), false)
  assert.equal(await disabledPage.evaluate(() => typeof window.__meshcoatMcp), 'undefined')
  await assert.rejects(access(join(disabledProfile, 'mcp-bridge.json')))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
  )
  await app.close()
  app = undefined
  const report = {
    passed: true,
    output,
    tools: listed.tools.map((t) => t.name),
    probe,
    measured,
    bundle,
    multipartBundle,
    status,
    verified: [
      'Official MCP SDK stdio handshake',
      '16 tools',
      'Unauthorized/origin/unknown-command rejection',
      'GLB import',
      'real height preset',
      'surface probe',
      'stroke',
      'native PNG16 export',
      'undo/redo exact height',
      'layered paint',
      'project save/reload exact height',
      'MCP screenshot image',
      'overwrite refusal preserves files',
      'dirty project protection',
      'invalid input rejection',
      'bridge cleanup',
      'normal launch has no bridge'
    ],
    rendererErrors: errors
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: true, output, tools: listed.tools.length }, null, 2))
} finally {
  if (client) {
    await client.close().catch(() => {})
  }
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}

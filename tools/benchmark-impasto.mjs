/* eslint-disable @typescript-eslint/explicit-function-return-type, max-depth -- Standalone measured GPU benchmark. */
import { _electron as electron } from 'playwright-core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'work'), { recursive: true })
const output = await mkdtemp(join(root, 'work/impasto-benchmark-'))
const env = { ...process.env, MESHCOAT_MCP: '1', MESHCOAT_USER_DATA: join(output, 'profile') }
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [root], env, timeout: 60000 })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForFunction(() => typeof window.__meshcoatMcp?.invoke === 'function')
  for (let i = 0; i < 300; i++) {
    const ready = await page.evaluate(async () => {
      try {
        await window.__meshcoatMcp.invoke('status', {})
        return true
      } catch {
        return false
      }
    })
    if (ready) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const cases = []
  for (const resolution of [512, 1024, 2048]) {
    for (const layers of [1, 6]) {
      for (const height of [false, true]) {
        const result = await page.evaluate(
          async ({ model, resolution, layers, height }) => {
            const invoke = window.__meshcoatMcp.invoke
            await invoke('open', { path: model, resolution, allowDiscard: true })
            await invoke('camera', { position: [0, 0, 3.3], target: [0, 0, 0] })
            const packs = await invoke('brushes', {}),
              preset = packs.find((p) => p.name === 'MeshCoat Sculpted Impasto').brushes[0].id
            const channels = [
              'baseColor',
              'roughness',
              'metalness',
              'normal',
              ...(height ? ['height'] : [])
            ]
            await invoke('set_brush', {
              preset,
              channels,
              radius: 0.25,
              height: 0,
              opacity: 1,
              spacing: 0.12,
              angleJitter: 0,
              sizeJitter: 0
            })
            await invoke('fill', {})
            for (let i = 1; i < layers; i++) {
              await invoke('add_layer', { name: 'Measured paint ' + i })
              await invoke('fill', {})
            }
            await invoke('set_brush', { height: 0.018 })
            const canvas = [...document.querySelectorAll('canvas')].find((c) => c.clientWidth > 700)
            const gl = canvas.getContext('webgl2'),
              rect = canvas.getBoundingClientRect()
            const ext = gl.getExtension('WEBGL_debug_renderer_info')
            const gpu = ext
              ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER)
            let draws = 0
            const originals = ['drawArrays', 'drawElements'].map((name) => [name, gl[name]])
            originals.forEach(([name, fn]) => {
              gl[name] = function (...args) {
                draws++
                return fn.apply(this, args)
              }
            })
            const event = (x, type, buttons) =>
              new PointerEvent(type, {
                clientX: rect.x + x * rect.width,
                clientY: rect.y + rect.height * 0.5,
                button: 0,
                buttons,
                pointerId: 9002,
                pointerType: 'mouse',
                pressure: 1,
                bubbles: true
              })
            const readback = new Uint8Array(4)
            const sync = () => {
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readback)
              if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
                throw new Error('GPU readback failed')
              }
            }
            const samples = []
            try {
              // One ongoing pointer stroke: no per-sample MCP calls or undo snapshots.
              canvas.dispatchEvent(event(0.34, 'pointerdown', 1))
              sync()
              for (let i = 1; i <= 36; i++) {
                draws = 0
                const start = performance.now()
                canvas.dispatchEvent(event(0.34 + (i * 0.32) / 36, 'pointermove', 1))
                const submitted = performance.now()
                sync()
                const finished = performance.now()
                if (draws > 0 && i > 4) {
                  samples.push({
                    submitMs: submitted - start,
                    finishedMs: finished - start,
                    drawCalls: draws
                  })
                }
              }
            } finally {
              canvas.dispatchEvent(event(0.66, 'pointerup', 0))
              originals.forEach(([name, fn]) => {
                gl[name] = fn
              })
            }
            const median = (key) => {
              const v = samples.map((s) => s[key]).sort((a, b) => a - b)
              return v[Math.floor(v.length / 2)]
            }
            return {
              gpu,
              resolution,
              actualResolution: (await invoke('status', {})).pieces[0].textureSize,
              paintLayers: layers,
              totalLayers: (await invoke('status', {})).layers.length,
              height,
              measuredSamples: samples.length,
              medianSubmitMs: median('submitMs'),
              medianFinishedMs: median('finishedMs'),
              medianDrawCalls: median('drawCalls'),
              samples
            }
          },
          { model: join(root, 'impasto/models/seam_panel.glb'), resolution, layers, height }
        )
        cases.push(result)
        console.log(JSON.stringify({ ...result, samples: undefined }))
      }
    }
  }
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        method:
          'Real pointer-move events during one stroke; 1-pixel synchronous readPixels forces GPU completion; viewport scene render and MCP round-trip excluded; warmed samples only; synthetic panel',
        cases
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ output }))
} finally {
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
    .catch(() => {})
  await app.close().catch(() => {})
}

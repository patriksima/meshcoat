const { _electron: electron } = require('playwright-core')
const fs = require('fs'),
  path = require('path'),
  { spawn } = require('child_process')
const root = path.resolve('impasto'),
  evidence = path.join(root, 'height-evidence')
fs.mkdirSync(evidence, { recursive: true })
const save = (name, url) => {
  if (!url) throw Error('Missing ' + name)
  fs.writeFileSync(path.join(evidence, name), Buffer.from(url.split(',')[1], 'base64'))
}
;(async () => {
  const server = spawn(process.execPath, ['tools/qa-server.mjs'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => {
      if (String(b).includes('ready')) resolve()
    })
    server.on('error', reject)
    server.on('exit', (c) => reject(Error('QA server exited ' + c)))
  })
  let app
  try {
    app = await electron.launch({
      args: [path.resolve('tools/qa-launch.cjs')],
      env: { ...process.env, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' },
      timeout: 60000
    })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1600, height: 1000 })
    const errors = []
    page.on('pageerror', (e) => {
      errors.push(e.message)
      console.log('PAGE ERROR', e.message)
    })
    page.on('console', (m) => {
      if (m.type() === 'error') {
        errors.push(m.text())
        console.log('CONSOLE ERROR', m.text())
      }
    })
    await page.waitForFunction(() => window.__paintRuntime?.sceneHandle)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.evaluate(async () => {
      window.qa = {
        ...(await import('/src/paint/brush.ts')),
        ...(await import('/src/paint/brushPresets.ts')),
        ...(await import('/src/paintQa.ts'))
      }
    })
    await page.waitForFunction(() => qa.brushPresets.ready())
    async function load(model, size = 2048) {
      await page.evaluate(
        async ({ model, size }) => {
          await window.__viewportHandle.loadFromUrl(window.api.assetUrl(model), 'glb', size, null, {
            forceTextureSize: true
          })
          const rt = window.__paintRuntime
          rt.sceneHandle.controls.setView(
            new qa.THREE.Vector3(0, 0, 3.3),
            new qa.THREE.Vector3(0, 0, 0)
          )
          rt.sceneHandle.camera.updateMatrixWorld(true)
          rt.sceneHandle.scene.children
            .filter((o) => o.type === 'GridHelper')
            .forEach((o) => (o.visible = false))
          window.__app.setActiveTool('brush')
        },
        { model: path.join(root, 'models', model + '.glb'), size }
      )
    }
    async function brush(height, color = '#a58142', radius = 0.34) {
      await page.evaluate(
        ({ height, color, radius }) => {
          qa.selectBrushPreset(
            qa.brushPresets.packs().find((p) => p.packName === 'MeshCoat Sculpted Impasto').brushes[0]
          )
          qa.setRadius(radius)
          qa.setOpacity(1)
          qa.brush.setColor(color)
          qa.brush.setHeightAmount(height)
          qa.brush.setAngleJitter(0)
          qa.brush.setSizeJitter(0)
        },
        { height, color, radius }
      )
      await page.waitForFunction(
        () => window.__paintRuntime.brushTipTexture?.image?.src === qa.brush.tipTexturePath()
      )
      if (
        (await page.getByPlaceholder('#RRGGBB, rgb(), hsl(), name').inputValue()).toLowerCase() !==
        color.toLowerCase()
      )
        throw Error('Test store and visible UI differ')
    }
    const screen = async (x, y, z = 0) =>
      await page.evaluate(
        ({ x, y, z }) => {
          const rt = window.__paintRuntime,
            r = rt.canvasRef.getBoundingClientRect(),
            p = new qa.THREE.Vector3(x, y, z).project(rt.sceneHandle.camera)
          return { x: r.x + ((p.x + 1) * r.width) / 2, y: r.y + ((1 - p.y) * r.height) / 2 }
        },
        { x, y, z }
      )
    async function stroke(a, b, n = 45) {
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: n })
      await page.mouse.up()
    }
    async function dump(label) {
      const maps = await page.evaluate(async () => {
        const h = window.__viewportHandle
        return {
          height: await h.exportHeightPng16(),
          albedo: h.exportBaseColorPng(),
          normal: h.exportChannelPng('normal'),
          roughness: h.exportChannelPng('roughness')
        }
      })
      for (const [key, url] of Object.entries(maps)) save(label + '_' + key + '.png', url)
      return maps
    }
    // Color/height independence and flat/low/high physical surface.
    for (const [label, amount] of [
      ['flat', 0],
      ['low', 0.008],
      ['high', 0.03]
    ]) {
      await load('seam_panel')
      await brush(amount)
      await stroke(await screen(-0.78, 0), await screen(0.78, 0))
      await dump(label)
      await page.mouse.move(40, 40)
      await page.screenshot({ path: path.join(evidence, label + '.png') })
      console.log('Finished', label)
    }
    // A second paint layer adds real height, then undo/redo and opacity must preserve it.
    const before = await page.evaluate(() => window.__viewportHandle.exportHeightPng16())
    await page.evaluate(() => window.__paintRuntime.layerStack.addLayer('Raised blue paint'))
    await brush(0.018, '#437ea0', 0.3)
    await stroke(await screen(0.2, -0.65), await screen(0.2, 0.65))
    const overlap = await dump('overlap')
    await page.mouse.move(40, 40)
    await page.screenshot({ path: path.join(evidence, 'overlap.png') })
    await page.evaluate(() => window.__viewportHandle.undo())
    const undone = await page.evaluate(() => window.__viewportHandle.exportHeightPng16())
    await page.evaluate(() => window.__viewportHandle.redo())
    const redone = await page.evaluate(() => window.__viewportHandle.exportHeightPng16())
    if (before !== undone || overlap.height !== redone) throw Error('Height undo/redo is not exact')
    await page.evaluate(() => {
      const s = window.__paintRuntime.layerStack
      s.setOpacity(s.activeId, 0.5, false)
    })
    await dump('half-layer')
    await page.evaluate(() => {
      const s = window.__paintRuntime.layerStack
      s.setOpacity(s.activeId, 1, false)
    })
    // Eraser must remove height along with paint; undo returns exact packed data.
    await page.evaluate(() => window.__app.setActiveTool('eraser'))
    await stroke(await screen(0.2, -0.35), await screen(0.2, 0.35))
    await dump('erased')
    await page.evaluate(() => window.__viewportHandle.undo())
    if ((await page.evaluate(() => window.__viewportHandle.exportHeightPng16())) !== overlap.height)
      throw Error('Eraser undo changed height')
    await page.evaluate(() => window.__app.setActiveTool('brush'))
    // Save + reopen the actual binary project: packed RG keeps all 16 scalar bits.
    async function saveProject(filename, modelName, modelFile) {
      return await page.evaluate(
        async ({ filename, modelName, modelFile }) => {
          const rt = window.__paintRuntime,
            ser = await import('/src/utils/projectSerializer.ts'),
            io = await import('/src/utils/fileIo.ts')
          const parts = await ser.serializeProject({
            modelPath: modelFile,
            modelName,
            pieces: rt.pieces.map((p) => ({ name: p.name, layerStack: p.stack }))
          })
          if (!(await io.writeFileParts(filename, parts))) throw Error('Project write failed')
          const restored = await ser.deserializeProject(await new Blob(parts).arrayBuffer())
          await window.__viewportHandle.loadProject(restored.project, restored.stackSnapshots)
          return restored.project.version
        },
        { filename, modelName, modelFile }
      )
    }
    const version = await saveProject(
      path.join(root, 'height_panel.meshcoat'),
      'MeshCoat Height Panel',
      path.join(root, 'models/seam_panel.glb')
    )
    const reloaded = await page.evaluate(() => window.__viewportHandle.exportHeightPng16())
    if (reloaded !== overlap.height) throw Error('Project round-trip changed height')
    await dump('reloaded')
    await page.evaluate(() => {
      const s = window.__paintRuntime.layerStack
      s.mergeDown(s.activeId)
    })
    if ((await page.evaluate(() => window.__viewportHandle.exportHeightPng16())) !== overlap.height)
      throw Error('Merge changed height')
    // Original low-poly tree, a small set of actual viewport strokes.
    await load('test_tree', 2048)
    await page.evaluate(() => {
      const rt = window.__paintRuntime,
        T = qa.THREE,
        e = rt.layerStack.activePaintEngine
      for (const [from, to, c] of [
        [0, 28, '#614632'],
        [28, 88, '#38533a']
      ])
        e.fillFaces(new Set(Array.from({ length: to - from }, (_, i) => from + i)), {
          color: new T.Color(c),
          alpha: 1,
          channels: {
            baseColor: { color: new T.Color(c), alpha: 1 },
            roughness: 0.9,
            metalness: 0,
            normal: 0
          }
        })
      rt.layerStack.recomposite()
      rt.layerStack.addLayer('Sculpted impasto')
      rt.sceneHandle.controls.setView(new T.Vector3(3.4, 4.2, 5.4), new T.Vector3(0, 1.9, 0))
      rt.sceneHandle.camera.updateMatrixWorld(true)
    })
    await brush(0.012, '#728752', 0.27)
    const routes = await page.evaluate(() => {
      const rt = window.__paintRuntime,
        T = qa.THREE,
        r = rt.canvasRef.getBoundingClientRect(),
        ray = new T.Raycaster(),
        list = []
      let seed = 732
      const rnd = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
      }
      for (let y = r.y + 80; y < r.bottom - 50; y += 33)
        for (let x = r.x + 140; x < r.right - 100; x += 34) {
          ray.setFromCamera(
            new T.Vector2(((x - r.x) / r.width) * 2 - 1, 1 - ((y - r.y) / r.height) * 2),
            rt.sceneHandle.camera
          )
          const h = ray.intersectObject(rt.pieces[0].mesh, false)[0]
          if (!h) continue
          const trunk = h.faceIndex < 28
          list.push({
            a: { x, y },
            b: { x: x + (trunk ? 3 : 15), y: y - (trunk ? 35 : 28) },
            trunk,
            color: trunk
              ? ['#92704c', '#b49161'][Math.floor(rnd() * 2)]
              : ['#617d46', '#84904e', '#a0a15c', '#496c42'][Math.floor(rnd() * 4)]
          })
        }
      return list
    })
    for (const route of routes) {
      await page.evaluate(({ trunk, color }) => {
        qa.brush.setColor(color)
        qa.setRadius(trunk ? 0.13 : 0.27)
        qa.brush.setHeightAmount(trunk ? 0.006 : 0.012)
        qa.setSelectedFaces(Array.from({ length: trunk ? 28 : 60 }, (_, i) => i + (trunk ? 0 : 28)))
      }, route)
      await stroke(route.a, route.b, 10)
    }
    await page.evaluate(() => qa.clearFaceSelection())
    await page.mouse.move(40, 40)
    await dump('tree')
    await page.screenshot({ path: path.join(evidence, 'tree-meshcoat.png') })
    await page.evaluate(() => window.__viewportHandle.setViewMode('height'))
    await page.screenshot({ path: path.join(evidence, 'tree-height.png') })
    await page.evaluate(() => window.__viewportHandle.setViewMode('material'))
    await saveProject(
      path.join(root, 'height_tree.meshcoat'),
      'MeshCoat Height Tree',
      path.join(root, 'models/test_tree.glb')
    )
    // Exercise native 16-bit height export button through the real app/IPC.
    const target = path.join(evidence, 'wizard-height16.png')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, target)
    await page.keyboard.press('Control+e')
    await page
      .getByRole('button', { name: 'Export Height16 PNG (native, per piece)', exact: true })
      .click()
    await page.waitForFunction(() => document.body.innerText.includes('native 16-bit height'))
    const info = await page.evaluate(() => {
      const rt = window.__paintRuntime
      return {
        channels: window.__viewportHandle.paintedChannels(),
        contextLost: rt.sceneHandle.renderer.getContext().isContextLost(),
        glError: rt.sceneHandle.renderer.getContext().getError()
      }
    })
    fs.writeFileSync(
      path.join(evidence, 'qa.json'),
      JSON.stringify(
        {
          version,
          exactUndoRedo: true,
          exactProjectReload: true,
          treeStrokes: routes.length,
          info,
          errors
        },
        null,
        2
      )
    )
    if (errors.length) throw Error(errors.join('\n'))
    console.log(JSON.stringify({ version, info, treeStrokes: routes.length, errors }))
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit(0))
    server.kill()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

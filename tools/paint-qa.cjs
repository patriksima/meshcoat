/* Real Electron + WebGL regression/visual fixture. Run qa-server.mjs first. */
const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const root = path.resolve('impasto')
const evidence = path.join(root, 'evidence')
fs.mkdirSync(evidence, { recursive: true })
fs.mkdirSync(path.join(root, 'textures'), { recursive: true })
const saveData = (name, url) => {
  if (!url) throw Error('Missing export ' + name)
  fs.writeFileSync(path.join(root, name), Buffer.from(url.split(',')[1], 'base64'))
}
;(async () => {
  const app = await electron.launch({
    args: [path.resolve('tools/qa-launch.cjs')],
    env: { ...process.env, ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' },
    timeout: 60000
  })
  try {
    const page = await app.firstWindow({ timeout: 30000 })
    await page.setViewportSize({ width: 1600, height: 1000 })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.waitForFunction(() => window.__paintRuntime?.sceneHandle, { timeout: 60000 })
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.evaluate(async () => {
      window.qa = {
        ...(await import('/src/paint/brush.ts')),
        ...(await import('/src/paint/brushPresets.ts')),
        ...(await import('/src/paintQa.ts'))
      }
    })
    async function load(name, size = 1024) {
      const model = path.join(root, 'models', name + '.glb')
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
          for (const obj of rt.sceneHandle.scene.children)
            if (obj.type === 'GridHelper') obj.visible = false
          window.__app.setActiveTool('brush')
        },
        { model, size }
      )
    }
    async function setup(radius = 0.32, strength = 0.018, color = '#a58142') {
      await page.evaluate(
        ({ radius, strength, color }) => {
          const b = qa.brush
          qa.selectBrushPreset(
            qa.brushPresets.packs().find((p) => p.packName.startsWith('MeshCoat')).brushes[0]
          )
          qa.setRadius(radius)
          b.setColor(color)
          b.setNormalStrength(strength)
          b.setAngleJitter(0)
          b.setSizeJitter(0)
          qa.setOpacity(1)
        },
        { radius, strength, color }
      )
      await page.waitForFunction(() => !!window.__paintRuntime.brushTipTexture)
      const visibleColor = await page.getByPlaceholder('#RRGGBB, rgb(), hsl(), name').inputValue()
      if (visibleColor.toLowerCase() !== color.toLowerCase()) {
        throw new Error('QA store differs from the visible app. Restart qa-server.mjs after source edits.')
      }
    }
    async function screen(x, y, z = 0) {
      return await page.evaluate(
        ({ x, y, z }) => {
          const rt = window.__paintRuntime,
            r = rt.canvasRef.getBoundingClientRect(),
            v = new qa.THREE.Vector3(x, y, z).project(rt.sceneHandle.camera)
          return { x: r.x + ((v.x + 1) * r.width) / 2, y: r.y + ((1 - v.y) * r.height) / 2 }
        },
        { x, y, z }
      )
    }
    async function stroke(a, b, steps = 60) {
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps })
      await page.mouse.up()
    }
    async function exports(prefix) {
      const result = await page.evaluate(() => {
        const h = window.__viewportHandle
        return {
          albedo: h.exportBaseColorPng(),
          normal: h.exportChannelPng('normal'),
          roughness: h.exportChannelPng('roughness'),
          orm: h.exportOrmPng()
        }
      })
      for (const [channel, url] of Object.entries(result))
        saveData(prefix + '_' + channel + '.png', url)
    }
    // Texture-space seam is between x=-epsilon/+epsilon on one coplanar surface.
    await load('seam_panel')
    await setup()
    await stroke(await screen(-0.78, 0), await screen(0.78, 0))
    await page.mouse.move(40, 40)
    await page.waitForTimeout(300)
    await exports('evidence/seam')
    await page.screenshot({ path: path.join(evidence, '01-seam-material.png') })
    await page.evaluate(() => window.__viewportHandle.setViewMode('normal'))
    await page.screenshot({ path: path.join(evidence, '02-seam-normal.png') })
    await page.evaluate(() => window.__viewportHandle.setViewMode('material'))
    // Analytical Y+ check: height increases in +world Y, so the outgoing
    // normal must lean towards -Y (green < 128), on a regular UV island.
    await load('seam_panel')
    await setup(0.4, 0.025)
    await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const ctx = c.getContext('2d'),
        d = ctx.createImageData(128, 128)
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          const i = (y * 128 + x) * 4
          d.data[i] = d.data[i + 1] = d.data[i + 2] = 220 - y
          d.data[i + 3] = 255
        }
      ctx.putImageData(d, 0, 0)
      qa.brush.setTipTexturePath(c.toDataURL())
      // Supply this analytical fixture explicitly so the assertion does not
      // race the library's asynchronous active-tip cache hydration.
      const texture = await new qa.THREE.TextureLoader().loadAsync(c.toDataURL())
      texture.colorSpace = qa.THREE.NoColorSpace
      texture.wrapS = texture.wrapT = qa.THREE.ClampToEdgeWrapping
      window.__paintRuntime.brushTipTexture = texture
    })
    await page.mouse.click((await screen(-0.5, 0)).x, (await screen(-0.5, 0)).y)
    await exports('evidence/opengl-ramp')
    // Three independent identical passes: color must remain identical as relief varies.
    for (const [label, strength] of [
      ['flat', 0],
      ['low', 0.02],
      ['high', 0.09]
    ]) {
      await load('seam_panel')
      await setup(0.32, strength)
      await stroke(await screen(-0.78, 0), await screen(0.78, 0))
      await exports('evidence/relief-' + label)
      await page.mouse.move(40, 40)
      await page.screenshot({ path: path.join(evidence, 'relief-' + label + '.png') })
    }
    // Opposing colors overpaint the same material footprint.
    await page.evaluate(() => qa.brush.setColor('#427c91'))
    await stroke(await screen(-0.1, -0.65), await screen(0.35, 0.65))
    await exports('evidence/overlap')
    await page.mouse.move(40, 40)
    await page.screenshot({ path: path.join(evidence, '03-overlap.png') })
    // Start the tree with a matte colored underpainting on real face selections.
    await load('test_tree', 2048)
    await page.evaluate(() => {
      const rt = window.__paintRuntime,
        T = qa.THREE,
        engine = rt.layerStack.activePaintEngine
      const pos = rt.pieces[0].mesh.geometry.attributes.position
      for (const [from, to, color] of [
        [0, 28, '#614632'],
        [28, 88, '#38533a']
      ]) {
        engine.fillFaces(new Set(Array.from({ length: to - from }, (_, i) => from + i)), {
          color: new T.Color(color),
          alpha: 1,
          channels: {
            baseColor: { color: new T.Color(color), alpha: 1 },
            roughness: 0.9,
            metalness: 0,
            normal: 0
          }
        })
      }
      rt.layerStack.recomposite()
      rt.sceneHandle.controls.setView(new T.Vector3(3.4, 4.2, 5.4), new T.Vector3(0, 1.9, 0))
    })
    await setup(0.26, 0.018, '#728752')
    await page.evaluate(() => {
      qa.brush.setAngleJitter(0.035)
      qa.brush.setSizeJitter(0.07)
      qa.brush.setJitterScope('stroke')
    })
    // Plan visible short directional strokes by raycast, then draw through the UI.
    let treeStrokes = 0
    for (const view of [
      [3.4, 4.2, 5.4],
      [-4, 4, 5],
      [-3.4, 4.2, -5.4],
      [4, 4, -5]
    ]) {
      await page.evaluate((view) => {
        const h = window.__paintRuntime.sceneHandle
        h.controls.setView(new qa.THREE.Vector3(...view), new qa.THREE.Vector3(0, 1.9, 0))
        h.camera.updateMatrixWorld(true)
      }, view)
      const routes = await page.evaluate(() => {
        const rt = window.__paintRuntime,
          T = qa.THREE,
          r = rt.canvasRef.getBoundingClientRect(),
          ray = new T.Raycaster(),
          routes = []
        let seed = 732
        const rnd = () => {
          seed = (seed * 16807) % 2147483647
          return seed / 2147483647
        }
        for (let y = r.y + 70; y < r.bottom - 50; y += 29)
          for (let x = r.x + 120; x < r.right - 100; x += 28) {
            const xx = x + (rnd() - 0.5) * 18,
              yy = y + (rnd() - 0.5) * 18
            ray.setFromCamera(
              new T.Vector2(((xx - r.x) / r.width) * 2 - 1, 1 - ((yy - r.y) / r.height) * 2),
              rt.sceneHandle.camera
            )
            const hit = ray.intersectObject(rt.pieces[0].mesh, false)[0]
            if (!hit) continue
            const trunk = hit.faceIndex < 28
            const shade = rnd()
            routes.push({
              a: { x: xx, y: yy },
              b: {
                x: xx + (trunk ? 4 : 10 + rnd() * 10),
                y: yy + (trunk ? -38 : -18 - rnd() * 14)
              },
              color: trunk
                ? ['#6e4e32', '#92704c', '#b49161'][Math.floor(shade * 3)]
                : ['#496c42', '#617d46', '#84904e', '#a0a15c', '#3f6147'][Math.floor(shade * 5)],
              trunk
            })
          }
        return routes
      })
      treeStrokes += routes.length
      console.log('Tree UI strokes (view):', routes.length)
      for (const route of routes) {
        await page.evaluate(({ color, trunk }) => {
          qa.brush.setColor(color)
          qa.setRadius(trunk ? 0.13 : 0.24)
          qa.brush.setNormalStrength(trunk ? 0.012 : 0.018)
          qa.setSelectedFaces(
            Array.from({ length: trunk ? 28 : 60 }, (_, i) => i + (trunk ? 0 : 28))
          )
        }, route)
        await stroke(route.a, route.b, 10)
      }
      await page.evaluate(() => qa.clearFaceSelection())
    }
    await page.evaluate(() =>
      window.__paintRuntime.sceneHandle.controls.setView(
        new qa.THREE.Vector3(3.4, 4.2, 5.4),
        new qa.THREE.Vector3(0, 1.9, 0)
      )
    )
    await page.mouse.move(40, 40)
    await page.waitForTimeout(500)
    await exports('textures/asset')
    await page.screenshot({ path: path.join(evidence, '04-tree-meshcoat.png') })
    await page.evaluate(() => window.__viewportHandle.setLightingMode('warm'))
    await page.screenshot({ path: path.join(evidence, '05-tree-warm-light.png') })
    await page.evaluate(() => window.__viewportHandle.setLightingMode('neutral'))
    // Preserve editable project through the upstream serializer.
    const project = await page.evaluate(
      async (modelPath) => {
        const serializer = await import('/src/utils/projectSerializer.ts')
        const h = window.__viewportHandle,
          rt = window.__paintRuntime
        const pieces = rt.pieces.map((p) => ({ name: p.name, layerStack: p.stack }))
        const parts = await serializer.serializeProject({
          modelPath,
          modelName: 'MeshCoat Impasto Tree',
          pieces
        })
        const blob = new Blob(parts),
          buffer = new Uint8Array(await blob.arrayBuffer())
        const target = modelPath.replace(/models[\\/]test_tree.glb$/, 'painted_tree.meshcoat')
        const io = await import('/src/utils/fileIo.ts')
        if (!(await io.writeFileParts(target, parts))) throw Error('Project save failed')
        const restored = await serializer.deserializeProject(buffer.buffer)
        await window.__viewportHandle.loadProject(restored.project, restored.stackSnapshots)
        rt.sceneHandle.controls.setView(
          new qa.THREE.Vector3(3.4, 4.2, 5.4),
          new qa.THREE.Vector3(0, 1.9, 0)
        )
        return {
          saved: target,
          bytes: buffer.length,
          roundTripPieces: restored.project.pieces.length
        }
      },
      path.join(root, 'models/test_tree.glb')
    )
    const info = await page.evaluate(() => {
      const rt = window.__paintRuntime
      return {
        pieces: window.__viewportHandle.pieces(),
        channels: window.__viewportHandle.paintedChannels(),
        contextLost: rt.sceneHandle.renderer.getContext().isContextLost(),
        glError: rt.sceneHandle.renderer.getContext().getError()
      }
    })
    // The visible hue wheel must drive the same brush color used by painting.
    const wheel = page.getByRole('slider', { name: 'Hue wheel' })
    await wheel.scrollIntoViewIfNeeded()
    const wb = await wheel.boundingBox()
    await page.mouse.click(wb.x + wb.width / 2, wb.y + wb.height * 0.96)
    const wheelColor = await page.evaluate(() => qa.brush.color())
    await page.screenshot({ path: path.join(evidence, '08-color-wheel.png') })
    // Exercise the real export wizard and IPC writer; only the native save
    // dialog answer is automated to keep output in this isolated fixture folder.
    const wizardDir = path.join(evidence, 'wizard-export')
    fs.mkdirSync(wizardDir, { recursive: true })
    await app.evaluate(
      ({ dialog }, target) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
      },
      path.join(wizardDir, 'asset_BaseColor.png')
    )
    await page.keyboard.press('Control+e')
    await page.getByRole('button', { name: 'All Unpacked', exact: true }).click()
    await page.screenshot({ path: path.join(evidence, '09-export-wizard.png') })
    const exportButton = page.getByRole('button', { name: /^Export \d+ Files?$/i })
    await exportButton.click()
    await page.waitForFunction(() => document.body.innerText.includes('Successfully exported'))
    // Confirm the built-in library can be selected through the visible UI.
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByText('Knife ridges 1', { exact: true }).last().click()
    const libraryPreset = await page.evaluate(() => qa.brushPresets.active().name)
    fs.writeFileSync(
      path.join(evidence, 'qa-run.json'),
      JSON.stringify(
        {
          info,
          errors,
          project,
          treeStrokes,
          wheelColor,
          libraryPreset,
          wizardFiles: fs.readdirSync(wizardDir)
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ info, errors, project }, null, 2))
  } finally {
    await app.evaluate(({ app }) => app.exit(0))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

const { _electron: electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
;(async () => {
  const app = await electron.launch({
    executablePath: path.resolve('dist/win-unpacked/MeshCoat.exe'),
    env: { ...process.env, MESHCOAT_USER_DATA: path.resolve('work/profiles/packaged') },
    timeout: 60000
  })
  try {
    const page = await app.firstWindow({ timeout: 30000 })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForFunction(() => window.__viewportHandle)
    await page.waitForTimeout(1000)
    // Use the production Open Project dialog path, not the dev-only runtime hook.
    const target = path.resolve('impasto/painted_tree.meshcoat')
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, target)
    await page.getByRole('button', { name: 'Open .meshcoat File...', exact: true }).click()
    await page.waitForFunction(() => window.__viewportHandle.paintedChannels().includes('normal'))
    await page.waitForTimeout(1500)
    const loaded = await page.evaluate(() => ({
      pieces: window.__viewportHandle.pieces(),
      channels: window.__viewportHandle.paintedChannels(),
      devHookPresent: !!window.__paintRuntime
    }))
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByText('Wavy bristles 1', { exact: true }).last().click()
    await page.getByRole('slider', { name: 'Hue wheel' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'impasto/evidence/10-packaged-meshcoat.png' })
    const exported = await page.evaluate(() => window.__viewportHandle.exportChannelPng('normal'))
    fs.writeFileSync(
      'impasto/evidence/packaged-normal.png',
      Buffer.from(exported.split(',')[1], 'base64')
    )
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    fs.writeFileSync(
      'impasto/evidence/packaged-smoke.json',
      JSON.stringify({ loaded, errors, userData }, null, 2)
    )
    if (errors.length) throw Error(errors.join('\n'))
    console.log(JSON.stringify({ loaded, errors, userData }))
  } finally {
    await app.evaluate(({ app }) => app.exit(0))
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})

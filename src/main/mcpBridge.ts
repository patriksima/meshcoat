import { writeGodotBundle } from './mcpGodot'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve, extname, dirname } from 'node:path'

const enabled = process.env.MESHCOAT_MCP === '1'
ipcMain.handle('mcp:is-enabled', () => enabled)

const commands = new Set([
  'inspect',
  'select_piece',
  'export_godot',
  'status',
  'brushes',
  'set_brush',
  'open',
  'camera',
  'probe',
  'stroke',
  'add_layer',
  'fill',
  'history',
  'save_project',
  'export',
  'screenshot'
])

async function assertNewFile(path: string, overwrite: unknown): Promise<void> {
  if (overwrite === true) {
    return
  }
  try {
    await stat(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw e
  }
  throw new Error(`File exists; choose a new path or set overwrite=true: ${path}`)
}

/** Opt-in local transport. MCP itself runs in mcp/server.mjs over stdio. */
export function startMcpBridge(win: BrowserWindow): void {
  if (!enabled) {
    return
  }
  const token = randomBytes(32).toString('hex')
  const endpoint = join(app.getPath('userData'), 'mcp-bridge.json')
  let queue: Promise<unknown> = Promise.resolve()
  const invoke = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    if (win.isDestroyed()) {
      throw new Error('MeshCoat window is closed')
    }
    // Only a closed command dispatcher is exposed; callers cannot supply code.
    return win.webContents.executeJavaScript(
      `window.__meshcoatMcp ? window.__meshcoatMcp.invoke(${JSON.stringify(command)},${JSON.stringify(args)}) : Promise.reject(new Error('MeshCoat is still starting or MCP is disabled'))`
    )
  }
  const dispatch = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    if (command === 'open') {
      if (
        typeof args.path !== 'string' ||
        !['.glb', '.gltf', '.obj', '.meshcoat'].includes(extname(args.path).toLowerCase())
      ) {
        throw new Error('Open requires a local .glb, .gltf, .obj or .meshcoat path')
      }
      args.path = resolve(args.path)
      if (!(await stat(args.path as string)).isFile()) {
        throw new Error('Not a file')
      }
      if (args.modelPath !== undefined) {
        if (typeof args.modelPath !== 'string') {
          throw new Error('Invalid modelPath')
        }
        args.modelPath = resolve(args.modelPath)
        if (!(await stat(args.modelPath as string)).isFile()) {
          throw new Error('Not a model file')
        }
      }
    }
    if (command === 'save_project') {
      if (typeof args.path !== 'string' || extname(args.path).toLowerCase() !== '.meshcoat') {
        throw new Error('Use a .meshcoat file path')
      }
      args.path = resolve(args.path)
      await assertNewFile(args.path as string, args.overwrite)
      await mkdir(dirname(args.path as string), { recursive: true })
    }
    if (command === 'screenshot') {
      try {
        const rect = (await invoke('viewport_rect', args)) as {
          x: number
          y: number
          width: number
          height: number
          feedback: unknown
        }
        const png = await win.webContents.capturePage({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        })
        const image = png.getSize().width > 1200 ? png.resize({ width: 1200 }) : png
        return {
          image: image.toPNG().toString('base64'),
          mimeType: 'image/png',
          width: image.getSize().width,
          height: image.getSize().height,
          coordinates: 'Normalized x/y in this viewport image, 0..1',
          feedback: rect.feedback
        }
      } finally {
        await invoke('restore_view', {})
      }
    }
    if (command === 'export_godot') {
      if (
        typeof args.directory !== 'string' ||
        typeof args.stem !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(args.stem)
      ) {
        throw new Error('Specify directory and an alphanumeric stem')
      }
      const data = (await invoke(command, args)) as {
        modelPath: string | null
        pieces: Parameters<typeof writeGodotBundle>[3]
      }
      if (!data.modelPath) {
        throw new Error('Open a GLB source first')
      }
      return writeGodotBundle(
        args.directory,
        args.stem,
        data.modelPath,
        data.pieces,
        args.overwrite === true
      )
    }
    if (command === 'export') {
      if (
        typeof args.directory !== 'string' ||
        typeof args.stem !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(args.stem)
      ) {
        throw new Error('Specify directory and an alphanumeric file stem')
      }
      const dir = resolve(args.directory)
      const maps = (await invoke('export', args)) as {
        channel: string
        suffix: string
        dataUrl: string
      }[]
      if (!maps.length) {
        throw new Error('No requested channels have been painted')
      }
      const files = maps.map((m) => ({
        channel: m.channel,
        path: join(dir, `${args.stem}_${m.suffix}.png`)
      }))
      for (const file of files) {
        await assertNewFile(file.path, args.overwrite)
      }
      await mkdir(dir, { recursive: true })
      for (let i = 0; i < maps.length; i++) {
        if (!maps[i].dataUrl.startsWith('data:image/png;base64,')) {
          throw new Error('Invalid PNG result')
        }
        await writeFile(files[i].path, Buffer.from(maps[i].dataUrl.split(',')[1], 'base64'))
      }
      return {
        files,
        resolution: 'native',
        heightEncoding: 'PNG16; height=(sample-32768)/32767 model units'
      }
    }
    return await invoke(command, args)
  }
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (
      req.headers.origin ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (req.method !== 'POST' || req.url !== '/invoke') {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      let length = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        length += chunk.length
        if (length > 1024 * 1024) {
          throw new Error('Request too large')
        }
        chunks.push(Buffer.from(chunk))
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (
        !message ||
        typeof message.command !== 'string' ||
        !commands.has(message.command) ||
        !message.args ||
        typeof message.args !== 'object' ||
        Array.isArray(message.args)
      ) {
        throw new Error('Invalid command')
      }
      const job = queue.then(() => dispatch(message.command, message.args))
      queue = job.catch(() => {})
      const result = await job
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ result }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  server.on('error', (error) => console.error('[MeshCoat MCP]', error.message))
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      return
    }
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(
        endpoint,
        JSON.stringify({ url: `http://127.0.0.1:${address.port}/invoke`, token, pid: process.pid }),
        { mode: 0o600 }
      )
    } catch (error) {
      console.error('[MeshCoat MCP]', error)
    }
  })
  win.once('closed', () => {
    server.close()
    // Electron can exit immediately after 'closed'; an async unlink may never finish.
    try {
      if (JSON.parse(readFileSync(endpoint, 'utf8')).token === token) {
        unlinkSync(endpoint)
      }
    } catch {
      /* Another instance may already have replaced or removed the endpoint. */
    }
  })
}

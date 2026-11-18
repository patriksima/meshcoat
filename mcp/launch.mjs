import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(require('electron'), ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MESHCOAT_MCP: '1',
    MESHCOAT_USER_DATA: process.env.MESHCOAT_USER_DATA || resolve(root, 'impasto-user-data')
  }
})
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})

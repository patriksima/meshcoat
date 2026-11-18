import { createServer } from 'vite'
import solid from 'vite-plugin-solid'
import tailwind from '@tailwindcss/vite'
const server = await createServer({
  configFile: false,
  root: 'src/renderer',
  plugins: [tailwind(), solid()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: [process.cwd()] } }
})
await server.listen()
console.log('MeshCoat QA Vite ready on http://127.0.0.1:5173')

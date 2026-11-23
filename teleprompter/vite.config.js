import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { isEssayFile } from './src/library/essay-files.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const essaysDir = path.resolve(root, '../essays')

function essaysApi() {
  return {
    name: 'essays-api',
    configureServer(server) {
      server.middlewares.use('/api/essays', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const names = fs.existsSync(essaysDir)
          ? fs.readdirSync(essaysDir).filter((name) => isEssayFile(name))
          : []
        const essays = names.sort((a, b) => a.localeCompare(b)).map((file) => ({
          file,
          text: fs.readFileSync(path.join(essaysDir, file), 'utf8'),
        }))
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(essays))
      })
    },
  }
}

const devHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [essaysApi()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  server: {
    host: devHost || '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: devHost
      ? {
          protocol: 'ws',
          host: devHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : undefined,
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})

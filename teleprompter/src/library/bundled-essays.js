/**
 * Essays shipped with the app. The glob is case-sensitive `E*.txt`, the same
 * rule as isEssayFile and the dev-server list at `/api/essays`.
 * `import.meta.glob` needs a static pattern, so the path stays a literal
 * and isEssayFile filters every candidate.
 */
import { isEssayFile } from './essay-files.js'
import { parseEssay } from './import-store.js'

const files = import.meta.glob('../../../essays/E*.txt', { query: '?raw', import: 'default', eager: true })

export function loadBundledEssays() {
  return Object.entries(files)
    .filter(([path]) => isEssayFile(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => parseEssay(path, raw))
}

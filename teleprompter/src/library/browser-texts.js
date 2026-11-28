import { parseEssay } from './import-store.js'
import { withDisplayCodes } from './texts-catalog.js'

const safeName = name => typeof name === 'string' && !/[\\/\0]/.test(name) && !name.startsWith('.')
const sideName = name => name.replace(/\.(txt|md)$/i, '.json')

export function createBrowserTexts(getFolder) {
  async function directory() {
    const folder = getFolder()
    if (!folder) throw new Error('Choose a library folder first.')
    if (await folder.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Allow access to this folder first.')
    return folder
  }
  async function list() {
    const folder = await directory()
    const rows = []
    for await (const [name, entry] of folder.entries()) {
      if (entry.kind !== 'file' || !safeName(name) || !/\.(txt|md)$/i.test(name)) continue
      const file = await entry.getFile()
      if (file.size > 2 * 1024 * 1024) throw new Error(`Text is too large: ${name}`)
      const raw = await file.text()
      let meta
      try {
        meta = JSON.parse(await (await (await folder.getFileHandle(sideName(name))).getFile()).text())
      } catch (error) {
        if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error
      }
      const legacy = !meta?.id && /^E\d+.*\.txt$/i.test(name) ? parseEssay(name, raw) : null
      rows.push({
        id: meta?.id || legacy?.file || `file-${name}`,
        title: meta?.title || legacy?.title || name.replace(/\.(txt|md)$/i, '').replace(/[-_]/g, ' '),
        body: legacy ? legacy.body : raw,
        code: meta?.code || legacy?.code || '',
        createdAt: meta?.createdAt ?? file.lastModified,
        updatedAt: meta?.updatedAt,
        name,
        extension: name.toLowerCase().endsWith('.txt') ? 'txt' : 'md',
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return withDisplayCodes(rows)
  }
  async function read(id) {
    const item = (await list()).find(item => item.id === id)
    if (!item) throw new Error('That text was not found.')
    return item
  }
  async function writeFile(folder, name, data) {
    const file = await folder.getFileHandle(name, { create: true })
    const stream = await file.createWritable()
    try { await stream.write(data); await stream.close() }
    catch (error) { await stream.abort().catch(() => {}); throw error }
  }
  async function write(record) {
    const folder = await directory()
    const rows = await list()
    const existing = rows.find(item => item.id === record.id)
    let name = existing?.name
    if (!name) {
      const slug = record.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 70) || 'text'
      const stem = `${record.code}-${slug}`
      const ext = record.extension === 'txt' ? 'txt' : 'md'
      for (let n = 1; ; n++) {
        const candidate = `${stem}${n === 1 ? '' : `-${n}`}.${ext}`
        let occupied = false
        for (const leaf of [candidate, sideName(candidate)]) {
          try { await folder.getFileHandle(leaf); occupied = true }
          catch (error) { if (error.name !== 'NotFoundError') throw error }
        }
        if (!occupied) { name = candidate; break }
      }
    }
    if (!safeName(name)) throw new Error('Invalid text filename.')
    await writeFile(folder, name, record.body)
    await writeFile(folder, sideName(name), JSON.stringify({ ...record, body: undefined, name: undefined, version: 1 }))
    return read(record.id)
  }
  async function remove(id) {
    const folder = await directory()
    const item = await read(id)
    if (!safeName(item.name)) throw new Error('Invalid text filename.')
    await folder.removeEntry(item.name)
    try { await folder.removeEntry(sideName(item.name)) }
    catch (error) { if (error.name !== 'NotFoundError') throw error }
  }
  return { list, read, write, remove }
}

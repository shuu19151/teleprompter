/**
 * Map between Documents/Teleprompter/texts and the import rows the sidebar
 * already renders. Migration writes each localStorage entry, reads it back,
 * and only then drops that entry. The id stays the one the takes already use.
 */

export function textExtension({ fileName = '', existing = '' } = {}) {
  const name = String(fileName || '')
  if (/\.txt$/i.test(name)) return 'txt'
  if (/\.md$/i.test(name)) return 'md'
  if (existing === 'txt' || existing === 'md') return existing
  return 'md'
}

export function nextImportCode(items) {
  let max = 0
  for (const item of items || []) {
    const match = /^U(\d+)$/.exec(item?.code || '')
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > max) max = value
  }
  return `U${max + 1}`
}

function takeCode(used, preferred) {
  if (preferred && !used.has(preferred)) {
    used.add(preferred)
    return preferred
  }
  let n = 1
  while (used.has(`U${n}`)) n += 1
  const code = `U${n}`
  used.add(code)
  return code
}

/** Give each migrated row the code it used to show, skipping codes already on disk. */
export function assignMigrationCodes(records, existing = []) {
  const used = new Set()
  for (const item of existing || []) {
    if (typeof item?.code === 'string' && item.code) used.add(item.code)
  }
  return (Array.isArray(records) ? records : []).map((record, index) => {
    const extension = textExtension({ fileName: record?.fileName, existing: record?.extension || 'md' })
    if (typeof record?.code === 'string' && record.code) {
      used.add(record.code)
      return { ...record, extension }
    }
    const code = takeCode(used, `U${index + 1}`)
    return { ...record, code, extension }
  })
}

export function fileToImport(file) {
  if (!file || typeof file.id !== 'string' || !file.id) return null
  const row = {
    id: file.id,
    title: typeof file.title === 'string' ? file.title : 'Untitled',
    body: typeof file.body === 'string' ? file.body : '',
    createdAt: file.createdAt == null ? 0 : file.createdAt,
    code: typeof file.code === 'string' ? file.code : '',
    extension: file.extension === 'txt' ? 'txt' : 'md',
    name: typeof file.name === 'string' ? file.name : '',
  }
  if (file.updatedAt != null) row.updatedAt = file.updatedAt
  return row
}

/** A stored code wins. A hand-dropped file with none gets the next free U code for display. */
export function withDisplayCodes(items) {
  const used = new Set((items || []).map((item) => item?.code).filter(Boolean))
  return (items || []).map((item, index) => {
    if (item.code) return item
    let n = index + 1
    let code = `U${n}`
    while (used.has(code)) {
      n += 1
      code = `U${n}`
    }
    used.add(code)
    return { ...item, code }
  })
}

export function filesToImports(files, { displayCodes = true } = {}) {
  const rows = []
  const seen = new Set()
  for (const file of Array.isArray(files) ? files : []) {
    const row = fileToImport(file)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return displayCodes ? withDisplayCodes(rows) : rows
}

export function toTextDraft(record) {
  const draft = {
    id: String(record?.id || ''),
    code: String(record?.code || ''),
    title: String(record?.title || ''),
    body: String(record?.body ?? ''),
    createdAt: record?.createdAt,
    extension: record?.extension === 'txt' ? 'txt' : 'md',
  }
  if (record?.updatedAt != null) draft.updatedAt = record.updatedAt
  return draft
}

export function sameCreatedAt(left, right) {
  return Object.is(left, right)
}

export function sameImport(file, record) {
  if (!file || !record || file.id !== record.id) return false
  if (file.title !== record.title) return false
  if (file.body !== record.body) return false
  if (!sameCreatedAt(file.createdAt, record.createdAt)) return false
  if (record.updatedAt == null) return file.updatedAt == null
  return sameCreatedAt(file.updatedAt, record.updatedAt)
}

/**
 * Copy each localStorage text that is not already the same file.
 * `verified` lists ids whose read-back matched. The caller removes only those.
 */
export async function migrateStoredImports({ records, readText, writeText }) {
  const verified = []
  const failed = []
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.id !== 'string' || !record.id) {
      failed.push('')
      continue
    }
    try {
      let current = await readText(record.id)
      if (!sameImport(current, record)) {
        await writeText(record)
        current = await readText(record.id)
      }
      if (sameImport(current, record)) verified.push(record.id)
      else failed.push(record.id)
    } catch {
      failed.push(record.id)
    }
  }
  return { done: failed.length === 0, verified, failed }
}

/** Drop verified ids from the raw localStorage array. Anything else stays. */
export function importsAfterMigration(rawList, verifiedIds) {
  if (!Array.isArray(rawList)) return { list: null, removeKey: false }
  const gone = new Set(verifiedIds || [])
  const list = rawList.filter((item) => !(item && typeof item.id === 'string' && gone.has(item.id)))
  return { list, removeKey: list.length === 0 }
}

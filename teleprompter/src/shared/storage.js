import { SPEED_KEY } from '../reading/reader-controller.js'

const LEGACY_KEYS = {
  [SPEED_KEY]: 'office-essay:speed',
}

export function readStorage(key, storage) {
  try {
    const store = storage || localStorage
    const value = store.getItem(key)
    if (value !== null) return value
    const legacy = LEGACY_KEYS[key]
    if (!legacy) return null
    const old = store.getItem(legacy)
    if (old === null) return null
    try {
      store.setItem(key, old)
    } catch {
      /* still use the legacy value */
    }
    return old
  } catch {
    return null
  }
}

export function writeStorage(key, value, storage) {
  try {
    const store = storage || localStorage
    store.setItem(key, value)
  } catch {
    /* ignore quota or private mode */
  }
}

export function loadJSON(key, storage) {
  try {
    const raw = readStorage(key, storage)
    if (raw === null) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

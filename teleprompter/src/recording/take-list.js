/**
 * Takes for the open text: render the list, play a row, and delete it.
 * The list is the Documents folder in the Tauri window. A row can be shown
 * in that folder. Deleting the row removes the audio file and its sidecar.
 */
import { inTauri } from '../library/essay-folder.js'
import { elementFromEvent, openRowMenu } from '../shared/row-menu.js'
import {
  chooseTakes,
  formatTakeDuration,
  formatTakeWhen,
  takeDateIso,
  takeTextKey,
} from './recorder-math.js'
import { DELETE_TAKE_MESSAGE, PLAY_TAKE_MESSAGE, SHOW_TAKE_MESSAGE } from './rec-messages.js'
import { revealTakeFile } from './take-disk.js'

function sameTake(left, right) {
  return left != null && right != null && String(left) === String(right)
}

export function createTakeList({
  store,
  getPanelMode,
  getPlayback,
  isRecordingActive,
  closeRecorderPanel,
  stopRecordingAndSave,
  openPlayback,
  togglePlayback,
  deps,
}) {
  let takesToken = 0
  let shownTakes = []

  function markActiveTake() {
    const playback = getPlayback()
    const id = getPanelMode() === 'playback' ? playback?.take?.id : null
    for (const row of document.querySelectorAll('#takes-list [data-take-id]')) {
      const on = sameTake(id, row.dataset.takeId)
      row.classList.toggle('is-on', on)
      const select = row.querySelector('.take-select')
      if (!select) continue
      select.setAttribute('aria-pressed', on ? 'true' : 'false')
      if (on) select.setAttribute('aria-current', 'true')
      else select.removeAttribute('aria-current')
    }
  }

  function renderTakeItem(take) {
    const when = formatTakeWhen(take.createdAt)
    const iso = takeDateIso(take.createdAt)
    const duration = formatTakeDuration(take.durationMs)
    const playback = getPlayback()
    const on = getPanelMode() === 'playback' && sameTake(playback?.take?.id, take.id)
    return `
    <li class="take-row ${on ? 'is-on' : ''}" data-take-id="${deps.escapeAttr(String(take.id))}">
      <button class="take-select" type="button" aria-pressed="${on ? 'true' : 'false'}" ${on ? 'aria-current="true"' : ''} aria-label="Play take from ${deps.escapeAttr(when)}, ${deps.escapeAttr(duration)}">
        <span class="take-meta">
          <time${iso ? ` datetime="${deps.escapeAttr(iso)}"` : ''}>${deps.escapeHtml(when)}</time>
          <span class="take-duration">${deps.escapeHtml(duration)}</span>
        </span>
      </button>
    </li>`
  }

  async function renderTakes() {
    const list = document.querySelector('#takes-list')
    if (!list) return
    const key = takeTextKey(deps.current())
    const token = ++takesToken
    let rows = []
    try {
      rows = key ? await store.list() : []
    } catch {
      if (token !== takesToken || !list.isConnected) return
      shownTakes = []
      list.innerHTML = '<li class="empty">Could not load takes.</li>'
      return
    }
    if (token !== takesToken || !list.isConnected || takeTextKey(deps.current()) !== key) return
    try {
      rows = chooseTakes(rows, deps.current())
      shownTakes = rows
      const playback = getPlayback()
      if (playback?.take && playback.take.textKey === key && !rows.some((row) => sameTake(row.id, playback.take.id))) {
        closeRecorderPanel()
      }
      if (!rows.length) {
        list.innerHTML = '<li class="empty">No takes yet.</li>'
        return
      }
      list.innerHTML = rows.map((take) => renderTakeItem(take)).join('')
      markActiveTake()
    } catch {
      if (token !== takesToken || !list.isConnected) return
      shownTakes = []
      list.innerHTML = '<li class="empty">Could not load takes.</li>'
    }
  }

  async function deleteShownTake(id) {
    const take = shownTakes.find((item) => sameTake(item.id, id))
    if (!take) return
    const when = formatTakeWhen(take.createdAt)
    const duration = formatTakeDuration(take.durationMs)
    const accepted = await deps.askConfirm({
      title: 'Delete take?',
      message: when ? `Delete the take from ${when} (${duration})?` : `Delete this take (${duration})?`,
    })
    if (!accepted) return
    try {
      await store.remove(id)
    } catch {
      deps.showNotice(DELETE_TAKE_MESSAGE)
      return
    }
    if (sameTake(getPlayback()?.take?.id, id)) closeRecorderPanel()
    await renderTakes()
  }

  async function playShownTake(id) {
    const take = shownTakes.find((item) => sameTake(item.id, id))
    if (!take) return
    const playback = getPlayback()
    if (getPanelMode() === 'playback' && sameTake(playback?.take?.id, id)) {
      if (playback.audio?.paused || playback.audio?.ended) togglePlayback()
      return
    }
    if (isRecordingActive()) await stopRecordingAndSave({ openAfter: false })
    const fresh = shownTakes.find((item) => sameTake(item.id, id)) || take
    let playing = fresh
    if (!playing.blob) {
      try {
        playing = { ...playing, blob: await store.readBlob(playing) }
      } catch {
        deps.showNotice(PLAY_TAKE_MESSAGE)
        return
      }
    }
    await openPlayback(playing)
  }

  function takeFromRow(row) {
    const id = row?.dataset.takeId
    if (!id) return null
    return shownTakes.find((item) => sameTake(item.id, id)) || null
  }

  function openTakeMenu(row, x, y, returnFocus) {
    const take = takeFromRow(row)
    if (!take) return
    const items = [{ label: 'Play', onSelect: () => void playShownTake(take.id) }]
    if (inTauri() && typeof take.diskPath === 'string' && take.diskPath) {
      items.push({
        label: 'Show in folder',
        onSelect: () => void showTakeInFolder(take),
      })
    }
    items.push({ label: 'Delete', danger: true, onSelect: () => void deleteShownTake(take.id) })
    openRowMenu({
      x,
      y,
      items,
      returnFocus: returnFocus instanceof HTMLElement ? returnFocus : row,
    })
  }

  async function showTakeInFolder(take) {
    try {
      await revealTakeFile(take.diskPath)
    } catch {
      deps.showNotice(SHOW_TAKE_MESSAGE)
    }
  }

  function onTakesContextMenu(event) {
    const source = elementFromEvent(event)
    const row = source?.closest('.take-row')
    if (!row) return
    event.preventDefault()
    openTakeMenu(row, event.clientX, event.clientY, source instanceof HTMLElement ? source : row)
  }

  function onTakesMenuKey(event) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const source = elementFromEvent(event)
    const row = source?.closest('.take-row')
    if (!row) return
    event.preventDefault()
    const anchor = source instanceof HTMLElement ? source : row
    const rect = anchor.getBoundingClientRect()
    openTakeMenu(row, rect.left, rect.bottom, anchor)
  }

  function onTakesClick(event) {
    const row = event.target.closest('.take-row')
    if (!row) return
    const id = row.dataset.takeId
    if (id) void playShownTake(id)
  }

  function bindExternalChanges() {
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        void renderTakes()
      })
    }
    if (!inTauri()) return
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('takes://changed', () => void renderTakes()))
      .catch(() => {})
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) void renderTakes()
        }),
      )
      .catch(() => {})
  }

  bindExternalChanges()

  return {
    markActiveTake,
    renderTakes,
    onTakesClick,
    onTakesContextMenu,
    onTakesMenuKey,
  }
}

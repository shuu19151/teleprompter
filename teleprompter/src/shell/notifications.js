let noticeTimer = 0
let noticeHideTimer = 0

function hideNotice(note) {
  note.hidden = true
  note.textContent = ''
  note.classList.remove('is-in', 'is-out')
}

export function showNotice(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return
  let note = document.querySelector('#notice')
  if (!note) {
    note = document.createElement('p')
    note.id = 'notice'
    note.className = 'notice'
    note.setAttribute('role', 'status')
    document.body.appendChild(note)
  }
  window.clearTimeout(noticeTimer)
  window.clearTimeout(noticeHideTimer)
  note.textContent = text
  note.hidden = false
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    note.classList.remove('is-out')
    note.classList.add('is-in')
    noticeTimer = window.setTimeout(() => hideNotice(note), 2000)
    return
  }
  const fadingOut = note.classList.contains('is-out')
  note.classList.remove('is-out')
  if (!note.classList.contains('is-in') || fadingOut) {
    if (!fadingOut) note.classList.remove('is-in')
    void note.offsetWidth
    note.classList.add('is-in')
  }
  noticeTimer = window.setTimeout(() => {
    note.classList.remove('is-in')
    note.classList.add('is-out')
    noticeHideTimer = window.setTimeout(() => hideNotice(note), 700)
  }, 2200)
}

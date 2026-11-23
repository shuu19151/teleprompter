/**
 * One in-page menu for a sidebar row.
 * Right-click and the menu key both open it. Esc, a click outside, and scrolling close it.
 */

let current = null

export function elementFromEvent(event) {
  if (event.target instanceof Element) return event.target
  if (event.target instanceof Node) return event.target.parentElement
  return null
}

export function openRowMenu({ x, y, items, returnFocus = null }) {
  closeRowMenu()
  if (!items?.length) return

  const menu = document.createElement('div')
  menu.className = 'row-menu'
  menu.setAttribute('role', 'menu')
  const buttons = items.map((item) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = item.danger ? 'row-menu-item danger' : 'row-menu-item'
    button.setAttribute('role', 'menuitem')
    button.textContent = item.label
    button.addEventListener('click', () => {
      closeRowMenu({ restore: true })
      item.onSelect()
    })
    menu.append(button)
    return button
  })

  menu.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(document.activeElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeRowMenu({ restore: true })
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length
      buttons[next]?.focus()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const step = event.shiftKey ? -1 : 1
      const next = (Math.max(index, 0) + step + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  })
  menu.addEventListener('contextmenu', (event) => event.preventDefault())

  menu.style.left = '0px'
  menu.style.top = '0px'
  menu.style.visibility = 'hidden'
  document.body.append(menu)
  const rect = menu.getBoundingClientRect()
  const margin = 8
  let left = x
  let top = y
  if (left + rect.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - rect.width)
  if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - rect.height)
  if (left < margin) left = margin
  if (top < margin) top = margin
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
  menu.style.visibility = 'visible'

  const onPointerDown = (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    closeRowMenu()
  }
  const onScroll = () => closeRowMenu()
  const onResize = () => closeRowMenu()
  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', onResize)
  current = { menu, returnFocus, onPointerDown, onScroll, onResize }
  buttons[0]?.focus({ preventScroll: true })
  // Focusing the first item can scroll the sidebar. Listen after that settles.
  requestAnimationFrame(() => {
    if (!current || current.menu !== menu) return
    document.addEventListener('scroll', onScroll, true)
  })
}

export function closeRowMenu({ restore = false } = {}) {
  if (!current) return
  const { menu, returnFocus, onPointerDown, onScroll, onResize } = current
  current = null
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
  menu.remove()
  if (restore && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus()
}

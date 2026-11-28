import { bindThemeToggle, theme, themeButtonMarkup } from './theme.js'

export function mountApp({
  sidebar,
  importDialog,
  confirmDialog,
  onThemeChange,
  onTakesClick,
  onTakesContextMenu,
  onTakesMenuKey,
  onTakesPointerDown,
  onTakesPointerMove,
  onTakesPointerEnd,
  renderSheet,
}) {
  const app = document.querySelector('#app')
  app.innerHTML = `
    <div class="window">
      <header class="topbar">
        <button class="menu" id="menu" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Menu">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
        <button class="tool" id="theme" type="button" aria-label="${theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}">${themeButtonMarkup(theme())}</button>
      </header>
      <div class="body">
${sidebar.markup()}
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet"></main>
      </div>
    </div>
${importDialog.markup()}
${confirmDialog.markup()}
  `
  sidebar.bind()
  bindThemeToggle({ onThemeChange })
  const takesList = document.querySelector('#takes-list')
  takesList?.addEventListener('click', onTakesClick)
  takesList?.addEventListener('contextmenu', onTakesContextMenu)
  takesList?.addEventListener('keydown', onTakesMenuKey)
  takesList?.addEventListener('pointerdown', onTakesPointerDown)
  takesList?.addEventListener('pointermove', onTakesPointerMove)
  takesList?.addEventListener('pointerup', onTakesPointerEnd)
  takesList?.addEventListener('pointercancel', onTakesPointerEnd)
  confirmDialog.bind()
  importDialog.bind()
  sidebar.renderList()
  renderSheet()
}

import { escapeAttr } from '../shared/html.js'
import { bindThemeToggle, theme } from './theme.js'

export function mountApp({
  query,
  sidebar,
  importDialog,
  confirmDialog,
  onThemeChange,
  onTakesClick,
  onTakesContextMenu,
  onTakesMenuKey,
  renderSheet,
}) {
  const app = document.querySelector('#app')
  app.innerHTML = `
    <div class="window">
      <header class="topbar">
        <button class="menu" id="menu" type="button" aria-controls="sidebar" aria-expanded="false">Menu</button>
        <div class="brand">Teleprompter</div>
        <label class="search">
          <span class="sr">Search texts</span>
          <input id="search" type="search" placeholder="Search" value="${escapeAttr(query)}" />
        </label>
        <button class="tool" id="theme" type="button">${theme() === 'dark' ? 'Light' : 'Dark'}</button>
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
  confirmDialog.bind()
  importDialog.bind()
  sidebar.renderList()
  renderSheet()
}

export function renderScriptHtml(body, escapeHtml) {
  return body
    .split('\n')
    .map((line) => (line.trim() ? `<p class="line">${escapeHtml(line)}</p>` : '<div class="gap"></div>'))
    .join('')
}

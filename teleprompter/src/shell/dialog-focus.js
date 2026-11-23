export function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden]')) return false
    return true
  })
}

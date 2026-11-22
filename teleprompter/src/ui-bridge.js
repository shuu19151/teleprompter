export const bridge = {
  isRunning: () => false,
  pauseRun() {},
  playRun() {},
  current: () => null,
  escapeHtml(value) {
    return value
  },
  escapeAttr(value) {
    return value
  },
  askConfirm() {
    return Promise.resolve(false)
  },
  showNotice() {},
}

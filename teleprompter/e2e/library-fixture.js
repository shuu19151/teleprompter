// Real browser file handles (OPFS) exercise the folder adapter without a native
// picker. They can also be saved in IndexedDB and restored across reloads.
export async function prepareLibrary(page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getDirectoryHandle('Test library', { create: true })
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('teleprompter-folder', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('folder')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('folder', 'readwrite')
      tx.objectStore('folder').put(handle, 'essays')
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
}

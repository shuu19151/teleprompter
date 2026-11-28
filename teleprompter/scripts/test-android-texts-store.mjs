import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const calls = []
let nextHandler = null

mock.module('@tauri-apps/api/core', {
  namedExports: {
    Resource: class {},
    Channel: class {},
    invoke: async (command, args) => {
      calls.push({ command, args })
      if (nextHandler) return nextHandler(command, args)
      return null
    },
  },
})

const prevWindow = globalThis.window
const prevNavigator = globalThis.navigator
globalThis.window = { __TAURI_INTERNALS__: {}, addEventListener: () => {} }
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Linux; Android 15)' },
  configurable: true,
})

const { createTextsStore } = await import('../src/library/texts-store.js')

test('Android texts-store boots to App Library and routes CRUD to android-documents plugin', async () => {
  calls.length = 0
  nextHandler = async (command, args) => {
    if (command === 'plugin:android-documents|getSavedDirectory') {
      return { uri: 'internal://texts', name: 'App Library', internal: true }
    }
    if (command === 'plugin:android-documents|listTexts') {
      return {
        items: [
          {
            id: 'abc',
            code: 'U1',
            title: 'Hello',
            body: 'World',
            createdAt: 1000,
            extension: 'md',
            name: 'U1-hello.md',
          },
        ],
      }
    }
    if (command === 'plugin:android-documents|readText') {
      return {
        id: args.id,
        code: 'U1',
        title: 'Hello',
        body: 'World',
        createdAt: 1000,
        extension: 'md',
        name: 'U1-hello.md',
      }
    }
    if (command === 'plugin:android-documents|writeText') {
      return {
        ...args.text,
        name: 'U1-hello.md',
      }
    }
    if (command === 'plugin:android-documents|deleteText') {
      return null
    }
    throw new Error(`Unexpected command: ${command}`)
  }

  const store = createTextsStore()
  await store.boot()
  assert.deepEqual(store.folder, { uri: 'internal://texts', name: 'App Library', internal: true })

  const list = await store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].title, 'Hello')

  const read = await store.read('abc')
  assert.equal(read.id, 'abc')

  const written = await store.write({
    id: 'abc',
    code: 'U1',
    title: 'Hello',
    body: 'Updated',
    createdAt: 1000,
    extension: 'md',
  })
  assert.equal(written.body, 'Updated')

  await store.remove('abc')
  assert.deepEqual(
    calls.map((c) => c.command),
    [
      'plugin:android-documents|getSavedDirectory',
      'plugin:android-documents|listTexts',
      'plugin:android-documents|readText',
      'plugin:android-documents|writeText',
      'plugin:android-documents|deleteText',
    ],
  )
})

test('Android texts-store choose() converts cancelled pickDirectory into AbortError', async () => {
  const store = createTextsStore()
  nextHandler = async (command) => {
    if (command === 'plugin:android-documents|pickDirectory') {
      throw new Error('Directory selection cancelled')
    }
    return null
  }
  await assert.rejects(
    () => store.choose(),
    (err) => err && err.name === 'AbortError',
  )
})

test.after(() => {
  globalThis.window = prevWindow
  if (prevNavigator !== undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: prevNavigator,
      configurable: true,
    })
  }
})

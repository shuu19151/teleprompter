# Refactor baseline

Phase 0 snapshot of the teleprompter, taken before any domain split. Later phases keep this behavior, this UI, and these stored shapes. There is no global reactive store: each module holds its own state and writes the DOM itself.

The layout after the last refactor phase is in `docs/architecture.md`. This file stays the record of behavior and stored data.

Commands below were run from `teleprompter/` on Node v22.23.4 and npm 10.9.9.

| Command | Result |
| --- | --- |
| `npm ci` | Exit 0. 24 packages, 0 vulnerabilities. |
| `npm test` | Exit 0. 4 passed, 0 failed (`scripts/test-mp4remux.mjs`: garbage blob, two ffmpeg remux cases, headless Chrome MediaRecorder). |
| `npm run build` | Exit 0. Vite 6.4.6, 31 modules, output in `teleprompter/dist`. |
| `npm run dev` | Vite served `http://127.0.0.1:5173/`. `GET /api/essays` returned the bundled `E*.txt` files. |

## localStorage

Keys are per origin. Quota and private-mode failures are swallowed, except an import write, which reports a full-storage error in the dialog and does not keep the text.

JSON cells below are the raw `localStorage` string (`JSON.stringify` of the value).

| Key | Raw value | Default when missing or invalid | Who writes it |
| --- | --- | --- | --- |
| `teleprompter:theme` | `"dark"` or `"light"` | Light. The `data-theme` attribute is absent. | `main.js` `setTheme`. `index.html` reads it before the module loads and, only for `"dark"`, sets `documentElement.dataset.theme`. |
| `teleprompter:speed` | JSON integer, `1`–`50` | `20` | Speed slider in `main.js`. |
| `teleprompter:fontSize` | JSON integer, `24`–`56` | `32` | Size slider in `main.js`. |
| `teleprompter:essay` | JSON object, see below | First bundled essay, index 0 | `saveProgress` in `main.js`, on pause, on a timed save while running, and when the open text changes. |
| `teleprompter:position` | JSON object, see below | Top of the open text (`offset` 0) | Same save path as `teleprompter:essay`. |
| `teleprompter:imports` | JSON array, see below | `[]` | `writeImports` in `text-import.js`. |
| `teleprompter:recWithRun` | `true` or `false` | `true` | "Start scrolling with recording" in `recorder-ui.js`. |
| `teleprompter:voiceEnhance` | `true` or `false` | `true` | Voice enhance checkbox in `recorder-ui.js`. |
| `teleprompter:micId` | Plain string, not JSON | Key absent. The menu shows Default microphone. | Microphone `<select>` in `recorder-ui.js`. An empty choice removes the key. |
| `teleprompter:essay-folder` | Plain directory path, not JSON | Key absent. The app uses the bundled essays. | Tauri folder picker in `essay-folder.js`. "Use app essays" removes the key. The browser picker does not write this key. |

### Legacy keys and migration

| Legacy key | Copied to | When |
| --- | --- | --- |
| `office-essay:theme` | `teleprompter:theme` | `readStorage` in `main.js` reads the new key, and if it is absent copies the legacy value across. The legacy key is left in place. |
| `office-essay:speed` | `teleprompter:speed` | Same copy-on-read. |

`index.html` also reads `office-essay:theme` when `teleprompter:theme` is absent, so the first paint can be dark before the module runs. That inline script does not write the new key. The module then calls `readStorage('teleprompter:theme')` at load, which performs the copy.

No other legacy keys are read. There is no migration for imports, position, font size, recording options, or the folder path.

### `teleprompter:essay`

One object for the text that was open at the last save:

```json
{ "file": "E01-how-i-stay-productive-and-calm.txt", "code": "E01", "kind": "essay", "id": "E01-how-i-stay-productive-and-calm.txt" }
```

```json
{ "file": "<import id>", "code": "U1", "kind": "import", "id": "<import id>" }
```

- Essay `file` and `id` are the filename (`E01-how-i-stay-productive-and-calm.txt`). `code` is the `E` plus digits in that name, or the whole filename when there are none.
- Import `file` and `id` are the import's `id`. `code` is the display code at save time (`U1`, `U2`, …) and is not used to find the text again.
- Restore for `kind: "import"` uses `id`, then `file`. If that import is gone, the reader opens the first essay.
- Restore for an essay matches `file`, then `code`.

### `teleprompter:position`

One slot for the text that is open, not a map per text. Choosing a different essay or import sets the reader to the top and replaces this object, so returning to the earlier text starts at the top.

Preferred shape, written when the open text has measured lines:

```json
{ "index": 4, "fraction": 0.18, "id": "E01-how-i-stay-productive-and-calm.txt" }
```

- `index` is the active script line. Blank lines are gaps and are not counted.
- `fraction` is how far the guide sits through that line.
- `id` is the essay filename, or the import id.

Fallback when line metrics are not ready:

```json
{ "offset": 120, "id": "E01-how-i-stay-productive-and-calm.txt" }
```

`offset` is the script's pixel scroll.

On load, a position whose `id` is a string is applied only when that `id` matches the open text. A line `index` outside the measured lines is ignored. When the line form does not apply, a numeric `offset` is used and clamped to the scroll range. The position is applied again when a folder listing arrives and no essay was on screen yet. It is not reapplied when the reader switches texts in the same visit.

### `teleprompter:imports`

```json
[
  {
    "id": "7c1e…",
    "title": "Market notes",
    "body": "Apples were expensive today.",
    "createdAt": "2026-11-23T04:50:00.000Z",
    "updatedAt": "2026-11-23T05:10:00.000Z"
  }
]
```

- `id`, `title`, and `body` are strings. Entries missing any of those are dropped on load.
- `createdAt` is a string or a number. A new import stores an ISO timestamp from `new Date().toISOString()`. On load, a missing or non-string/non-number `createdAt` is replaced in memory with a fresh ISO timestamp. That replacement is not written back until the next save.
- `updatedAt` is optional, string or number, and is set on edit. A new import does not have it.
- `id` comes from `crypto.randomUUID()` when available, otherwise `u-<base36 time>-<base36 random>`.
- Edit keeps `id` and `createdAt`. Empty text and text over 200 KB are rejected and not stored.

## IndexedDB

### Takes

| | |
| --- | --- |
| Database | `teleprompter` |
| Version | `1` |
| Store | `takes` |
| Primary key | `id`, key path, auto-increment |
| Indexes | `textKey` on `textKey`, not unique |

Upgrade creates the store and the index only when the store is missing. There is no later migration.

Stored record, written by `commitTake` in `recorder-ui.js` through `addTake`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | number | Assigned by IndexedDB. |
| `textKey` | string | Essay code (`E01`) or, for an import, the import `id`. Takes are listed for the open text by this field. |
| `code` | string | Essay code, or `"take"` when the open text has no code. |
| `title` | string | Title of the open text. |
| `createdAt` | number | `Date.now()` when the take is committed. |
| `durationMs` | number | Rounded recording length. |
| `mimeType` | string | Blob type after the optional M4A remux. |
| `extension` | string | `m4a` for mp4/aac, otherwise `webm`. |
| `blob` | Blob | The audio. An empty blob is not stored. |
| `diskPath` | string, optional | Absolute path under Documents when the Tauri shell saved the file. Absent in the browser. |

`livePeaks` and `livePeakOrigin` are attached to the in-memory object after the transaction completes, for playback in that visit. They are not part of the stored record.

A full store surfaces "Could not save this take because browser storage is full." and the take is not kept.

### Essay folder handle

| | |
| --- | --- |
| Database | `teleprompter-folder` |
| Version | `1` |
| Store | `folder` |
| Primary key | Out of line. No key path and no indexes. |
| Record | Key `"essays"` → a `FileSystemDirectoryHandle` |

Used by the browser folder picker. The Tauri shell stores the path in `teleprompter:essay-folder` instead, and still deletes this record when the reader chooses "Use app essays". The browser's directory-picker id `teleprompter-essays` is the File System Access permission id, not a key in localStorage or IndexedDB.

## Main user flows

1. Open the app. The stage shows the first bundled essay (E01, then E02, then E03 by filename), or the essay or import saved in `teleprompter:essay`, at the line saved in `teleprompter:position`.
2. Run and pause from the Run button or Space. The script scrolls at the saved speed. Pause writes the reading position immediately. While running, the position is written about 300ms after the last movement. Wheel and the "To the top" button move the same script.
3. Reload. The saved text opens on the saved line. A deleted import falls back to the first essay.
4. Choose another essay or import in the sidebar. That text opens at the top, and the single position slot now belongs to it. Coming back to the previous text starts at the top.
5. Search. The box filters essay codes and titles, and imported codes, titles, and scripts.
6. Import a text from the Import dialog (typed title and script, or a `.txt` / `.md` file) or by dropping a file on the window. The new text opens on the stage. Right-click it to edit or delete. Edit of the text on stage keeps the line when the script is unchanged, and keeps the line index (clamped) when the script changes.
7. Theme. Dark and Light persist in `teleprompter:theme`.
8. Font size (24–56, default 32) and speed (1–50, default 20) persist. The script uses Literata. Controls stay in JetBrains Mono.
9. Fullscreen from the stage button or F. Esc leaves it. Shortcuts do nothing while a dialog is open or while typing in a text field.
10. Record from Rec or R. Stop ends the take. With "Start scrolling with recording" on (the default), Rec starts scrolling and recording together, Stop pauses scrolling, and Run pause/resume follows the recorder. The option itself persists.
11. The finished take appears under Takes for the open text. Click a row to play it. Right-click to play or delete. Delete asks first and removes the IndexedDB record. In the Tauri app, Stop also writes `Documents/Teleprompter/<code>-<slug>-<stamp>.m4a` (or `.webm`), a second take in the same minute gets `-2`, and the menu can show that file. Deleting the row leaves the file.
12. Microphone choice and Voice enhance persist. Voice enhance defaults to on. Both controls are disabled during a take. A denied mic, a missing mic, or a browser that cannot record shows a short message under the controls.
13. Folder, beside Essays, picks a directory. The Tauri app uses the system folder dialog and remembers the path. Chrome or Edge on the dev server uses the browser folder picker and remembers the handle. Reload reads that folder. "Use app essays" returns to the bundled files. Right-click a folder essay to open it, delete the `.txt` (after confirm), or, in Tauri, show it in the folder. The dev-server reload button calls `/api/essays` and is hidden in a production build until a folder is chosen.
14. Closing the Tauri window saves the reading position and stops an open take, which stores whatever was recorded.

## Regression matrix

Every later phase is checked with the unit suite, the Playwright smoke suite, and a production build. The Tauri column is the manual desktop check for that phase.

| Phase | Unit test | Playwright smoke | Build | Tauri |
| --- | --- | --- | --- | --- |
| Extract pure functions | Yes | Yes | Yes | No |
| Move files | Yes | Yes | Yes | No |
| Shell/dialog | Yes | Yes | Yes | stage milestone |
| Library | Yes | Yes | Yes | choose folder and reveal |
| Reader | Yes | Yes | Yes | fullscreen and shortcuts |
| Recorder UI | Yes | Yes | Yes | record and save to Documents |
| Remove bridge | Yes | Yes | Yes | full recording flow |
| Reduce main | Yes | Yes | Yes | full regression |

## Phase 1 smoke

`npm run test:smoke` launches Chromium through Playwright with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`. The dev server is `vite --mode test`. The suite waits on DOM state.

- The default essay is E01, "How I Stay Productive and Calm at Work", with its opening line on the stage.
- Run sets the Run button to Pause (`aria-pressed="true"`). Pause sets it back to Run and leaves the active script line where it stopped. A reload opens E01 on that same line.
- Choosing E02 shows that essay. Choosing E01 again opens it at the top, because the single position slot was replaced. A reload keeps E01 and that top line.
- Importing a `.txt` file opens it under My texts and shows the title and script on the stage.
- Dark theme and a font size of 44px are still applied after reload.
- Rec, then the panel Stop, with the fake microphone, adds one row under Takes.

The active line is stable across reload, so the suite reads it from the DOM. There is no `window.__teleprompterTest` hook. A production build must not contain that string.

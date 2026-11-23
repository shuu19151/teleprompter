# Module layout

`src/main.js` is the composition root (226 lines, down from 383). It imports each domain, creates it, passes the callbacks that domain needs, and starts the app. There is no `ui-bridge.js`, no global reactive store, and no event bus. Each module holds its own state and writes the DOM itself.

`window.__teleprompterTest` is not defined. Playwright starts `vite --mode test` and reads the DOM. A production build must not contain the string `__teleprompterTest`.

Behavior, CSS, and DOM ids and classes are unchanged. `teleprompter:position` is still one slot for the open text, written by `src/reading/reader-progress.js`. Takes are the exception: `Documents/Teleprompter` is the list. `src-tauri` scans that folder, deletes a take, reads its audio for playback, and watches the folder.

## Wiring order

Later modules call earlier ones only through functions that run after startup, so the constructors can close over bindings that are assigned further down the file.

1. Confirm dialog.
2. Recorder. Its callback object reads the reader and the library once those exist. The constructor does not call the callbacks.
3. Reader layout, progress, and view.
4. Reader controller. It receives `syncRecorderToRun` and `toggleRecording`.
5. Fullscreen. A size change asks the recorder to repaint the waveform.
6. Library. It receives `stopRecordingAndSave`, `closeRecorderPanel`, the reader, and the sidebar.
7. Import dialog and sidebar.

`readThemeStorage()` copies a legacy theme key. `start()` then:

- In the Tauri shell, listens for the window close, saves the reading position, and stops an open take.
- Boots the essay folder and restores the saved text.
- Warms the recording store and the script size.
- Mounts the window.
- Listens for microphone changes.
- Remeasures when the fonts are ready.

Page hide, the context-menu block, fullscreen changes, and keyboard shortcuts are bound while that startup is still in flight.

## What the recorder receives

`createRecorder` in `src/recording/recorder-ui.js` takes one object:

| Callback | From |
| --- | --- |
| `isRunning`, `pauseRun`, `playRun` | Reader controller |
| `current` | Library, the open essay or import |
| `escapeHtml`, `escapeAttr` | `src/shared/html.js` |
| `askConfirm` | Confirm dialog |
| `showNotice` | `src/shell/notifications.js` |

The takes list and the record/stop controller are the only consumers. Microphone, waveform, and panel chrome do not see this object.

## Files

Line counts are the file length after this phase, including comments.

| File | Lines | Owns |
| --- | --- | --- |
| `src/main.js` | 226 | Composition root |
| `src/style.css` | 1256 | Unchanged presentation |
| `src/shell/app-shell.js` | 46 | Window markup and the first bind of theme, takes, dialogs, and the stage |
| `src/shell/lifecycle.js` | 29 | Tauri close, page leave, context-menu block |
| `src/shell/theme.js` | 48 | `teleprompter:theme`, including the legacy `office-essay:theme` copy |
| `src/shell/fullscreen.js` | 63 | Stage fullscreen |
| `src/shell/notifications.js` | 44 | Corner notice |
| `src/shell/confirm-dialog.js` | 87 | Delete confirmation |
| `src/shell/dialog-focus.js` | 6 | Tab cycle inside a dialog |
| `src/library/bundled-essays.js` | 17 | Eager `E*.txt` glob |
| `src/library/essay-files.js` | 16 | Case-sensitive essay filename rule |
| `src/library/essay-folder.js` | 234 | Folder picker, Tauri path, browser handle |
| `src/library/import-store.js` | 237 | `teleprompter:imports` and text parsing |
| `src/library/import-dialog.js` | 252 | Import and edit dialog |
| `src/library/content-selection.js` | 93 | Which text is open, and the position-slot shape |
| `src/library/library-controller.js` | 456 | Essay list, imports, folder boot |
| `src/library/sidebar-view.js` | 304 | Sidebar markup and row menus |
| `src/reading/reader-math.js` | 96 | Scroll, focus, and progress math |
| `src/reading/reader-layout.js` | 186 | `teleprompter:fontSize` and stage measurement |
| `src/reading/reader-progress.js` | 119 | `teleprompter:essay` and the single `teleprompter:position` slot |
| `src/reading/reader-controller.js` | 297 | Run, pause, speed, wheel, keyboard |
| `src/reading/reader-view.js` | 265 | Stage markup |
| `src/recording/recorder-ui.js` | 160 | Recorder composition, created from `main.js` |
| `src/recording/recorder-controller.js` | 406 | Record, stop, and save |
| `src/recording/recorder-view.js` | 108 | Panel markup and live chrome |
| `src/recording/microphone-controller.js` | 264 | Microphone choice and the analyser graph |
| `src/recording/waveform-view.js` | 422 | Waveform, ruler, and seeking |
| `src/recording/take-list.js` | 195 | Takes for the open text, refreshed from the folder |
| `src/recording/recording.js` | 623 | Capture, the browser IndexedDB mirror, and the M4A remux call |
| `src/recording/mp4remux.js` | 918 | AAC remux into one M4A file |
| `src/recording/take-disk.js` | 74 | Documents audio file and sidecar |
| `src/recording/takes-catalog.js` | — | Sidecar shape, migration, and the in-memory catalog |
| `src/recording/takes-store.js` | — | Tauri commands or the in-memory catalog |
| `src/recording/recorder-math.js` | 173 | Take list and waveform calculations |
| `src/shared/storage.js` | 44 | `readStorage`, `writeStorage`, `loadJSON`. Copies `office-essay:speed` onto `teleprompter:speed` when the new key is missing |
| `src/shared/html.js` | 11 | `escapeHtml` and `escapeAttr` |
| `src/shared/row-menu.js` | 102 | Right-click row menu |

## Takes

`Documents/Teleprompter` is the list of takes in the Windows app. A take is `<name>.m4a` plus `<name>.json` (`version`, `textKey`, `durationMs`, `createdAt`, `peaks`, `mime`). Names that already exist get `-2`, `-3`, and so on. Directories whose names start with `.`, including `.sessions/`, are not takes.

`takes_list` scans that folder. A missing or unreadable sidecar falls back to the code and the local timestamp in the file name, and to a probed duration. `takes_delete` removes the audio file and the sidecar. `takes_read` returns the audio bytes for playback; the read stays inside the folder. A debounced watcher emits `takes://changed`. The page also rescans when it starts and when the window gains focus.

The first launch copies each IndexedDB take that does not already have a non-empty file, writes the sidecar for a file that is already there, and only then deletes the blob. `teleprompter:takesMigrated` is set after that finishes. Stopping halfway leaves the flag unset, and the next launch continues.

Outside the Tauri window the same store methods keep an in-memory list and still write the blob to IndexedDB, so the Playwright page can record a take and read it back.

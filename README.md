# Teleprompter

A local teleprompter for reading spoken English essays aloud.

## Run

```bash
cd teleprompter
npm install
npm run dev
```

Open the address Vite prints, usually http://127.0.0.1:5173/

## Build and preview

```bash
npm run build
npm run preview
```

`npm run build` writes a static site to `teleprompter/dist`. `npm run preview` serves that build at http://127.0.0.1:4173/. Essays are copied into the bundle when you build, so preview does not notice files added afterwards.

## Essays

Essays are plain text files in `essays/` at the repo root. The name is case-sensitive: a capital `E`, then anything, then a lowercase `.txt` extension. `E01-short-title.txt` is included. `e01-short-title.txt` and `E01-short-title.TXT` are not. The same rule is used by the production glob (`E*.txt`) and by the dev-server list at `/api/essays`.

The first blank-line-separated block is the title. The rest is the script.

The reload button next to Essays calls `/api/essays`. That route exists only on the Vite dev server, so the button is hidden in `build` and `preview`. On the dev server, press it to pick up a new file without restarting.

## Your own text

Import, in the sidebar under My texts, opens a dialog where you can type a title, paste a script, or choose a `.txt` or `.md` file. The title and text fields, including their placeholders, use the same Literata stack as the script. The small labels and the dialog buttons stay in JetBrains Mono. The file is read as UTF-8. You can also drop a `.txt` or `.md` file anywhere on the window.

Imported text is split the same way as a bundled essay. The first block, up to a blank line, is the title, and the rest is the script. A title you type replaces that block. If there is no blank line, a pasted text uses its first line as the title, and a file uses its file name; either way the text stays on the stage. For Markdown, a leading `#` heading mark on a line is removed and the line is kept as text. Empty text is rejected, and anything over 200 KB is rejected. Both messages appear in the dialog.

Each import is stored in this browser under `teleprompter:imports` as `{ id, title, body, createdAt }`. A later edit keeps that id and `createdAt` and adds `updatedAt`. If storage is full, the dialog says so and the text is not kept. My texts lists them with codes U1, U2, and so on. The search box matches those codes, titles, and scripts as well as the essays. Edit and Delete sit on each row. Delete asks you to confirm.

Edit opens the same dialog, headed Edit text, with the stored title and the stored script filled in. Saving without changes writes that same script back. Save updates the entry in place. Cancel, Close, Esc, and a click on the backdrop throw the edits away. Opening Import afterwards is a blank import again, headed Import text, with the button labeled Import. The file field still replaces the script when you choose a `.txt` or `.md` file. Empty text and anything over 200 KB are rejected in the dialog, the same as import. A blank title is filled from the block before the first blank line, or from the first line when there is none. If you chose a file and the script has no blank line, the file name is used instead. The script in the box is what gets stored. For a Markdown file, a leading `#` heading mark on a line is removed, the same as import.

If the text you edit is the one on stage, Save redraws it. When the script is unchanged, the reading position stays on the same line. When the script changes, the reader keeps that same line index, clamped to the last line if the new script is shorter. Choosing an imported text otherwise works like choosing an essay: Space runs and pauses, the reading position is saved with that text's id, and a reload opens the same text at the same line. If the saved text has been deleted, the reader opens the first essay instead. Titles and scripts are shown as text, not as HTML.

## Reading

Space starts and pauses scrolling. F toggles fullscreen on the reading stage, and Esc leaves it. A rust guide marks the reading point, about a third of the way down the stage. The size slider runs from 24px to 56px (32px by default) and is remembered in `localStorage` under `teleprompter:fontSize`. Script text uses Literata, with Source Serif and Georgia as fallbacks. Labels and controls stay in JetBrains Mono.

## Recording

Rec, next to Run, records the microphone while you read. R starts and stops it, including in fullscreen, and does nothing while you are typing in a text field. The button shows a red dot and an elapsed `mm:ss` timer while a take is open. In fullscreen the same control sits on the stage, because the transport row is hidden. Space still only starts and pauses scrolling.

The microphone needs a secure page. `https` works, and so does the dev server on `http://127.0.0.1`, which counts as localhost. A denied permission, a missing microphone, or a browser without recording shows a short message under the controls.

"Start scrolling with recording" is on by default and is stored in `localStorage` under `teleprompter:recWithRun`. While it is on, Rec starts scrolling and recording together, and stopping the recording pauses scrolling. Pausing Run pauses the recorder, and resuming Run resumes it, using `MediaRecorder.pause` and `resume`. While the option is off, recording keeps going when scrolling is paused. Turning the option off mid-take resumes a recorder that was paused with Run.

Each finished take is stored in IndexedDB (database `teleprompter`, store `takes`), keyed by the essay code (`E01`) or the imported text's id, so a reload brings the same takes back. The list under the stage shows the time, the duration, a player, Download, and Delete. Delete asks you to confirm. Download uses `<code>-<title-slug>-<YYYYMMDD-HHMM>.webm` (or `.mp4` when that is the recorded type), from the text's code and title at the time of the take. If storage is full, a message under the controls says so and the take is not kept. Switching texts, hiding the page, or leaving it stops the take and saves what was recorded. The microphone is released when the take stops. Blob URLs for the players are revoked when the list is redrawn or a take is removed.

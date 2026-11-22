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

Each import is stored in this browser under `teleprompter:imports` as `{ id, title, body, createdAt }`. If storage is full, the dialog says so and the text is not kept. My texts lists them with codes U1, U2, and so on. The search box matches those codes, titles, and scripts as well as the essays. Rename and Delete sit on each row. Delete asks you to confirm.

Choosing an imported text works like choosing an essay: Space runs and pauses, the reading position is saved with that text's id, and a reload opens the same text at the same line. If the saved text has been deleted, the reader opens the first essay instead. Titles and scripts are shown as text, not as HTML.

## Reading

Space starts and pauses scrolling. F toggles fullscreen on the reading stage, and Esc leaves it. A rust guide marks the reading point, about a third of the way down the stage. The size slider runs from 24px to 56px (32px by default) and is remembered in `localStorage` under `teleprompter:fontSize`. Script text uses Literata, with Source Serif and Georgia as fallbacks. Labels and controls stay in JetBrains Mono.

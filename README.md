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

## Windows app

The desktop shell is Tauri 2. The window loads this same Vite app. From `teleprompter/`:

```bash
npm run tauri dev
```

That starts Vite at http://127.0.0.1:5173 and opens a desktop window. A Windows installer is built on Windows, with Rust MSVC, the C++ build tools, and WebView2:

```bash
npm run tauri build
```

The setup file is `teleprompter/src-tauri/target/release/bundle/nsis/` (`*-setup.exe`). The MSI is in `teleprompter/src-tauri/target/release/bundle/msi/`. The NSIS installer is per user and does not ask for administrator rights. The installed app opens without `npm run dev`, and the bundled E01 and E02 essays are inside it.

Stopping a recording writes that take into the Windows Documents folder, `Documents\Teleprompter\`, which is the list of takes. Each take is an `.m4a` file plus a `.json` sidecar with the same name, for example `E01-how-i-stay-productive-and-calm-20261122-1804.m4a` and `.json`. A second take in the same minute gets `-2` before the extension. Hidden folders such as `.sessions` are not takes. Right-click a take to play it, show that file in Explorer, or delete it. Delete asks first and removes both files. Deleting or renaming a file in Explorer updates the list.

All texts live in one library folder selected with **Folder**. Each saved text is a `.md` or `.txt` file plus a `.json` sidecar containing its stable ID, display code, title and timestamps. Import, edit and delete operate on this folder. Deleting a text removes its file and sidecar; recordings remain in `Documents\Teleprompter\`. The app remembers the library across launches. A missing or inaccessible folder reports an error and can be reconnected with Folder.

## Text library

Essays are plain text files in `essays/` at the repo root. The name is case-sensitive: a capital `E`, then anything, then a lowercase `.txt` extension. `E01-short-title.txt` is included. `e01-short-title.txt` and `E01-short-title.TXT` are not. The same rule is used by the production glob (`E*.txt`) and by the dev-server list at `/api/essays`.

The first blank-line-separated block is the title. The rest is the script.

On first choosing a library, the app copies its bundled examples and existing My texts into that folder. It verifies each copy and checkpoints migration progress. Original files in `Documents\Teleprompter\texts` and legacy `teleprompter:imports` entries remain as backups. Completed migration is not repeated when you switch folders or delete a migrated text. Reading IDs and existing recording keys are preserved.

Texts is a single searchable list for examples, folder files and imports. Click a text to read it; right-click to edit or delete it. Delete asks for confirmation before removing the file. Refresh reloads external changes. Automatic refresh waits while the import/edit dialog is open, and saving refuses to overwrite a file changed outside the app.

Folder opens the native directory picker in the Windows app, or the browser directory picker in Chrome/Edge. The library includes `.txt` and `.md` files directly in that directory; subfolders are not read. Changing the folder selects another library without copying the previous library into it. Canceling the picker keeps the current library. Browser access requires read/write permission; Refresh can request it again.

## Your own text

Import, beside Folder under Texts, opens a dialog where you can type a title, paste a script, or choose a UTF-8 `.txt` or `.md` file. You can also drop a file onto the window. Choose a library folder before importing. A matching title and body (ignoring outer whitespace and newline differences) opens the existing text instead of creating a duplicate; different content with the same title is saved separately.

Imported text is split the same way as a bundled essay. The first block, up to a blank line, is the title, and the rest is the script. A title you type replaces that block. If there is no blank line, a pasted text uses its first line as the title, and a file uses its file name; either way the text stays on the stage. For Markdown, a leading `#` heading mark on a line is removed and the line is kept as text. Empty text is rejected, and anything over 200 KB is rejected. Both messages appear in the dialog.

Both the Windows app and supported browsers write imports into the selected folder. Edits preserve the ID and creation time and add an update time. The search box matches codes, titles and scripts. Imported files use U1, U2, and so on; migrated examples retain their E codes.

Edit opens the same dialog, headed Edit text, with the stored title and the stored script filled in. Saving without changes writes that same script back. Save updates the entry in place. Cancel, Close, Esc, and a click on the backdrop throw the edits away. Opening Import afterwards is a blank import again, headed Import text, with the button labeled Import. The file field still replaces the script when you choose a `.txt` or `.md` file. Empty text and anything over 200 KB are rejected in the dialog, the same as import. A blank title is filled from the block before the first blank line, or from the first line when there is none. If you chose a file and the script has no blank line, the file name is used instead. The script in the box is what gets stored. For a Markdown file, a leading `#` heading mark on a line is removed, the same as import.

If the text you edit is the one on stage, Save redraws it. When the script is unchanged, the reading position stays on the same line. When the script changes, the reader keeps that same line index, clamped to the last line if the new script is shorter. Choosing an imported text otherwise works like choosing an essay: Space runs and pauses, the reading position is saved with that text's id, and a reload opens the same text at the same line. If the saved text has been deleted, the reader opens the first essay instead. Titles and scripts are shown as text, not as HTML.

## Reading

Space starts and pauses scrolling. F toggles fullscreen on the reading stage, and Esc leaves it. A rust guide marks the reading point, about a third of the way down the stage. The size slider runs from 24px to 56px (32px by default) and is remembered in `localStorage` under `teleprompter:fontSize`. Script text uses Literata, with Source Serif and Georgia as fallbacks. Labels and controls stay in JetBrains Mono.

## Recording

Rec, next to Run, opens a recorder panel in the gap between the controls and the reading stage. The panel is the full width of the stage and about 140px tall. It slides open; with reduced motion it opens without the slide. R starts and stops a take, including in fullscreen, and does nothing while you are typing in a text field. In fullscreen the transport row is hidden, so the same Rec control sits on the stage and the panel sits at the top of the stage. Space still only starts and pauses scrolling.

While a take is recording, the panel shows a time ruler (a label every 1.6 seconds, such as `00:00.00` and `00:01.60`, with smaller ticks between them), a live waveform on a canvas, and one red playhead fixed at the horizontal center. At the start, `00:00.00` sits on that line and the left side is empty. The ruler fills the rest of the width with later times, including times still ahead of the playhead. The waveform's newest sample stays on the playhead, and nothing is drawn to the right of it. The ruler and waveform scroll left together from the first moment. The ruler has no marks before `00:00.00`. The clock is elapsed time as `mm:ss.cc` (for example `00:04.08`). Stop, the square button, ends the take. Pause holds the recorder; when "Start scrolling with recording" is on, it pauses scrolling too, and Resume continues both. A microphone menu sits small at the left of the panel, in the same mono muted type as the old device name. The same menu sits in the gap under the controls when the panel is closed, and it hides while the panel is open. The choice is remembered in `localStorage` under `teleprompter:micId`. The menu is disabled while a take is recording. Before the browser shares device names, it shows Default microphone. Stopping releases the microphone and closes the audio graph.

Voice enhance sits beside that menu, in the same small muted type, and again in the panel. It is on by default and is stored in `localStorage` under `teleprompter:voiceEnhance`. While it is on, the microphone passes through a highpass, a gentle compressor, a little makeup gain, and a limiter before it is recorded, and the waveform follows that processed signal. While it is off, the recorder takes the microphone directly. Either way, echo cancellation, noise suppression, and automatic gain stay off. The control is disabled during a take, so a change applies next time.

The panel then plays that take: the whole waveform and the ruler scroll under the same centered playhead, with play and pause and the current time over the duration. The ruler still fills the width on both sides of the playhead. At the start of playback, `00:00.00` is on the playhead. Click or drag the waveform to seek. Close collapses the panel. Rec again starts a new take in the panel.

The microphone needs a secure page. `https` works, and so does the dev server on `http://127.0.0.1`, which counts as localhost. A denied permission, a missing microphone, or a browser without recording shows a short message under the controls.

"Start scrolling with recording" is on by default and is stored in `localStorage` under `teleprompter:recWithRun`. While it is on, Rec starts scrolling and recording together, and stopping the recording pauses scrolling. Reaching the last line stops scrolling and leaves the recording running until Stop. Pausing Run pauses the recorder, and resuming Run resumes it, using `MediaRecorder.pause` and `resume`. The panel's Pause and Resume follow that same link. While the option is off, recording keeps going when scrolling is paused, and Pause on the panel holds only the recorder. Turning the option off mid-take resumes a recorder that was paused with Run.

In the Windows app, each finished take is an `.m4a` file and a `.json` sidecar in `Documents\Teleprompter\`. The sidecar stores the text key (the essay code, or the imported text's id), the duration, the time, a short waveform, and the audio type. Takes for the current text are listed in the sidebar under Takes, below My texts. Each row shows the time and the duration. Click a row to play that take. Right-click a row to play it, show the file in Explorer, or delete it. Delete asks you to confirm and removes both files. If the files cannot be written, a message under the controls says so and the take is not kept. The first launch copies takes that were previously kept in IndexedDB into that folder, then drops those audio blobs. Switching texts, hiding the page, or leaving it stops an open take and saves what was recorded. The microphone is released when the take stops. In the browser on the dev server, takes stay in this page so the recorder can be tried without the Windows app.

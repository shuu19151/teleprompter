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

## Reading

Space starts and pauses scrolling. F toggles fullscreen on the reading stage, and Esc leaves it. A rust guide marks the reading point, about a third of the way down the stage. The size slider runs from 24px to 56px (32px by default) and is remembered in `localStorage` under `teleprompter:fontSize`. Script text uses Literata, with Source Serif and Georgia as fallbacks. Labels and controls stay in JetBrains Mono.

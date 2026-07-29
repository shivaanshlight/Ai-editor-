# Building the edit.ai desktop installer

This turns edit.ai into a real Windows app (`edit.ai Setup x.y.z.exe`) your
friend can double-click — no Node, no ffmpeg, no manual setup.

## What the installer bundles
- **Node runtime + the whole app** (via Electron)
- **ffmpeg + ffprobe** (via `ffmpeg-static` / `ffprobe-static`) — no system install needed
- On **first launch**, the app auto-downloads:
  - the **transcription engine** (whisper, ~500 MB, one time)
  - the **scoring model** (embeddings, ~90 MB, on first edit)

So the installed app works **offline and key-free** after that first download.
(Optional extras — the local LLM for content-kit/chat via Ollama, and the AI
upscaler — are still separate installs; the app works without them.)

## Build it (run these on a Windows machine)

```bat
:: 1. install dependencies (adds electron + electron-builder + ffmpeg)
npm install

:: 2. build the frontend once (produces public/index.html)
cd web && npm install && npm run build:single && cd ..

:: 3. build the installer
npm run dist
```

The finished installer lands in **`dist\edit.ai Setup 0.5.0.exe`**. Send that
one file to anyone — they run it and get a desktop app + Start-menu shortcut.

## Try it locally without building (dev)
```bat
npm install
npm run electron
```
This opens the app in the desktop window using your working tree.

## Notes / gotchas
- **First run downloads ~500 MB** (whisper). The splash screen shows progress.
  After that it's instant and offline.
- Install location is **per-user** (`%LOCALAPPDATA%\Programs\edit.ai`), which is
  writable — that's deliberate, so uploads/outputs/models live next to the app.
- **Icon:** drop a `build\icon.ico` (256×256) before `npm run dist` to brand the
  installer + window; otherwise the default Electron icon is used.
- **Antivirus / SmartScreen:** an unsigned installer triggers a "Windows
  protected your PC" warning. Click *More info → Run anyway*. To remove the
  warning for real, you need a **code-signing certificate** (~$100–200/yr) and
  add `win.certificateFile` to the `build` config in `package.json`.
- **macOS / Linux:** `npm run dist:mac` / `npm run dist:linux` (build on that OS).

## Roadmap to a cleaner install
- Bundle whisper + a small model *inside* the installer (bigger download, but
  zero first-run wait).
- Code-sign so there's no SmartScreen warning.
- Bundle the local LLM (llama.cpp + a small Apache-2.0 model) so content-kit and
  chat work without a separate Ollama install.

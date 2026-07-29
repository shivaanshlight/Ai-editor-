/**
 * electron/main.js — desktop wrapper for edit.ai.
 *
 * Starts the bundled Node server, bundles ffmpeg/ffprobe (prepended to PATH so
 * the engine finds them without a system install), downloads the transcription
 * engine on first launch, and opens the app in a native window.
 *
 * Packaging note: electron-builder runs with asar disabled + a per-user install
 * (%LOCALAPPDATA%), so the app folder is writable and the server's normal
 * uploads/ outputs/ bin/ models/ paths work unchanged — no path refactor.
 */
const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { fork } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || "38473"; // uncommon port, avoids clashes
process.env.PORT = PORT;
const URL = `http://127.0.0.1:${PORT}`;

let win;

/** Prepend bundled ffmpeg/ffprobe dirs to PATH so spawn("ffmpeg") resolves. */
function wireFfmpeg() {
  const dirs = [];
  try {
    dirs.push(path.dirname(require("ffmpeg-static")));
  } catch (e) {
    console.error("ffmpeg-static missing:", e.message);
  }
  try {
    dirs.push(path.dirname(require("ffprobe-static").path));
  } catch (e) {
    console.error("ffprobe-static missing:", e.message);
  }
  if (dirs.length) {
    process.env.PATH = dirs.join(path.delimiter) + path.delimiter + (process.env.PATH || "");
  }
}

/** Is the local whisper transcription engine already installed? */
function whisperPresent() {
  try {
    return fs
      .readdirSync(path.join(ROOT, "bin"))
      .some((f) => /whisper|main/i.test(f) && !f.endsWith(".zip"));
  } catch {
    return false;
  }
}

/** Minimal splash page with a live log area. */
function splashHTML(title, sub) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta charset=utf-8><body style="margin:0;height:100vh;background:#0a0b0e;color:#eceef3;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px">
      <div style="font-size:20px;font-weight:600;letter-spacing:-.02em">edit<span style="color:#5b8cff">.ai</span></div>
      <div id="t" style="font-size:14px;color:#969cab">${title}</div>
      <div id="s" style="font-size:12px;color:#626775">${sub || ""}</div>
      <pre id="log" style="max-width:70vw;max-height:30vh;overflow:auto;font:11px ui-monospace,monospace;color:#5f6672;white-space:pre-wrap"></pre>
      <script>window.__log=t=>{var l=document.getElementById('log');l.textContent=(l.textContent+t).slice(-1200);l.scrollTop=l.scrollHeight;};window.__sub=t=>{document.getElementById('s').textContent=t;};</script>
    </body>`)
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0a0b0e",
    title: "edit.ai",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
}

/** First launch: download the transcription engine (~500 MB, one time). */
function downloadWhisper() {
  return new Promise((resolve) => {
    const send = (t) => {
      if (win && !win.isDestroyed())
        win.webContents.executeJavaScript(`window.__log && window.__log(${JSON.stringify(String(t))})`).catch(() => {});
    };
    const child = fork(path.join(ROOT, "scripts", "setup-whisper.js"), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      silent: true,
    });
    child.stdout && child.stdout.on("data", send);
    child.stderr && child.stderr.on("data", send);
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function waitForServer(cb, tries = 0) {
  http
    .get(URL, () => cb())
    .on("error", () => {
      if (tries > 240) return cb(new Error("server did not start"));
      setTimeout(() => waitForServer(cb, tries + 1), 500);
    });
}

app.whenReady().then(async () => {
  wireFfmpeg();

  // Start the bundled server (listens on PORT).
  try {
    require(path.join(ROOT, "server.js"));
  } catch (e) {
    dialog.showErrorBox("edit.ai failed to start", String((e && e.stack) || e));
    app.quit();
    return;
  }

  createWindow();

  // First run: fetch the transcription engine before opening the app.
  if (!whisperPresent()) {
    win.loadURL(splashHTML("Setting up edit.ai — first run", "Downloading the transcription engine (~500 MB). One time only."));
    await downloadWhisper();
  }

  win.loadURL(splashHTML("Starting edit.ai…", ""));
  waitForServer((err) => {
    if (err) {
      dialog.showErrorBox("edit.ai", "The engine didn't start.\n" + err.message);
      return;
    }
    win.loadURL(URL);
  });
});

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) app.whenReady().then(createWindow);
});

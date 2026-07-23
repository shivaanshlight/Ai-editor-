/**
 * scripts/setup-upscaler.js — one-time download of Real-ESRGAN (ncnn-vulkan)
 * for the AI video enhancer. Runs on the GPU via Vulkan (no CUDA). ~35 MB.
 *
 *   node scripts/setup-upscaler.js
 *
 * Puts realesrgan-ncnn-vulkan(.exe) + models/ into ./bin/, where lib/upscale.js
 * looks for them. Delete bin/realesrgan-ncnn-vulkan* to remove.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin");

// Stable Real-ESRGAN ncnn-vulkan release (bundles the exe + all models).
const ASSETS = {
  win: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip",
  linux: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip",
  mac: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip",
};

async function download(url, dest, label) {
  console.log(`↓ ${label}\n  ${url}`);
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "edit-ai-setup" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = parseInt(res.headers.get("content-length") || "0");
  const file = fs.createWriteStream(dest);
  let got = 0, last = -10;
  for await (const chunk of res.body) {
    file.write(chunk);
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= last + 10) { last = pct; process.stdout.write(`  ${pct}% (${(got / 1e6).toFixed(0)} MB)\r\n`); }
    }
  }
  await new Promise((r) => file.end(r));
  console.log(`  saved → ${dest}`);
}

function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Expand-Archive failed");
  } else {
    const r = spawnSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("unzip failed (install unzip)");
  }
}

/** Find the exe anywhere under dir and lift it (plus models/) into bin/. */
function liftBinary(dir) {
  const exeNames = ["realesrgan-ncnn-vulkan.exe", "realesrgan-ncnn-vulkan"];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const f = walk(p); if (f) return f; }
      else if (exeNames.includes(e.name)) return p;
    }
    return null;
  };
  const exe = walk(dir);
  if (!exe) return null;
  const srcDir = path.dirname(exe);
  // move every file next to the exe (exe, dlls, models/) into bin/
  const copyRec = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name), d = path.join(to, e.name);
      if (e.isDirectory()) copyRec(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copyRec(srcDir, BIN);
  const finalExe = path.join(BIN, path.basename(exe));
  try { fs.chmodSync(finalExe, 0o755); } catch {}
  return finalExe;
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const url = ASSETS[plat];
  const zip = path.join(BIN, "realesrgan.zip");
  const tmp = path.join(BIN, "_realesrgan_tmp");

  await download(url, zip, "Real-ESRGAN (ncnn-vulkan)");
  fs.rmSync(tmp, { recursive: true, force: true });
  extractZip(zip, tmp);
  const exe = liftBinary(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });

  if (!exe) throw new Error("extracted, but no realesrgan-ncnn-vulkan binary found");
  console.log(`\n✓ enhancer ready: ${exe}`);
  console.log("  Uses your GPU via Vulkan (needs a current graphics driver).");
  console.log("  Restart the server — the “Enhance to 1080p” option will appear on Find Clips.");
}

main().catch((e) => {
  console.error("\nSetup failed:", e.message);
  console.error("Manual: download the windows zip from");
  console.error("  https://github.com/xinntao/Real-ESRGAN/releases");
  console.error("  extract realesrgan-ncnn-vulkan.exe + models/ into ./bin/");
  process.exit(1);
});

/**
 * scripts/setup-whisper.js — one-command local transcription setup.
 *
 *   npm run setup-whisper              (small model, ~466 MB — recommended)
 *   npm run setup-whisper -- --model=base   (~142 MB, faster, less accurate)
 *
 * Downloads the whisper.cpp Windows binary (from the official GitHub
 * release) into ./bin and a ggml model (from the official Hugging Face
 * repo) into ./models. After this, transcription is local, free, and has
 * NO rate limits — Groq is only used if these files are missing.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin");
const MODELS = path.join(ROOT, "models");

const MODEL = (process.argv.find((a) => a.startsWith("--model=")) || "--model=small").split("=")[1];
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin`;

async function download(url, dest, label) {
  console.log(`↓ ${label}\n  ${url}`);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "edit-ai-setup" },
  });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = parseInt(res.headers.get("content-length") || "0");
  const file = fs.createWriteStream(dest);
  let got = 0;
  let lastPct = -10;
  for await (const chunk of res.body) {
    file.write(chunk);
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  ${pct}% (${(got / 1e6).toFixed(0)} MB)\r\n`);
      }
    }
  }
  await new Promise((r) => file.end(r));
  console.log(`  saved → ${dest}`);
}

async function latestWindowsAsset() {
  const res = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest", {
    headers: { "User-Agent": "edit-ai-setup", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel = await res.json();
  const asset =
    (rel.assets || []).find((a) => /bin-x64\.zip$/i.test(a.name)) ||
    (rel.assets || []).find((a) => /win.*x64.*\.zip$/i.test(a.name)) ||
    (rel.assets || []).find((a) => /x64.*\.zip$/i.test(a.name));
  if (!asset) throw new Error("no Windows x64 zip in the latest release — see manual steps below");
  return { url: asset.browser_download_url, name: asset.name, tag: rel.tag_name };
}

function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
    if (r.status !== 0) throw new Error("Expand-Archive failed: " + r.stderr);
  } else {
    const r = spawnSync("unzip", ["-o", zipPath, "-d", destDir]);
    if (r.status !== 0) throw new Error("unzip failed");
  }
}

function findExe(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) stack.push(p);
      else if (/^(whisper-cli|main)(\.exe)?$/i.test(f)) return p;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(MODELS, { recursive: true });

  // 1) binary
  const already = ["whisper-cli.exe", "whisper-cli", "main.exe", "main"]
    .map((f) => path.join(BIN, f))
    .find((p) => fs.existsSync(p));
  if (already) {
    console.log(`✓ whisper binary already present: ${already}`);
  } else if (process.platform === "win32") {
    const asset = await latestWindowsAsset();
    const zip = path.join(BIN, asset.name);
    await download(asset.url, zip, `whisper.cpp ${asset.tag} (${asset.name})`);
    extractZip(zip, BIN);
    fs.unlink(zip, () => {});
    const exe = findExe(BIN);
    if (!exe) throw new Error("binary zip extracted but no whisper-cli.exe/main.exe found");
    // normalize location so the app finds it
    const target = path.join(BIN, "whisper-cli.exe");
    if (path.resolve(exe) !== path.resolve(target)) fs.copyFileSync(exe, target);
    console.log(`✓ binary ready: ${target}`);
  } else {
    console.log("Non-Windows: build whisper.cpp once →");
    console.log("  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && make");
    console.log(`  then copy build/bin/whisper-cli to ${BIN}/`);
  }

  // 2) model
  const modelDest = path.join(MODELS, `ggml-${MODEL}.bin`);
  if (fs.existsSync(modelDest) && fs.statSync(modelDest).size > 10e6) {
    console.log(`✓ model already present: ${modelDest}`);
  } else {
    await download(MODEL_URL, modelDest, `whisper ${MODEL} model`);
    console.log(`✓ model ready: ${modelDest}`);
  }

  console.log("\nDone. Restart the server (node server.js) — it will say:");
  console.log("  Transcription: local whisper.cpp ✓ (no rate limits)");
  console.log("Delete bin/ + models/ any time to go back to Groq.");
}

main().catch((e) => {
  console.error("\nSetup failed:", e.message);
  console.error("\nManual fallback:");
  console.error("  1) https://github.com/ggml-org/whisper.cpp/releases → download the x64 zip,");
  console.error("     extract, put whisper-cli.exe into ./bin/");
  console.error(`  2) ${MODEL_URL} → save into ./models/`);
  process.exit(1);
});

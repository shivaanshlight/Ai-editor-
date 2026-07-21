/**
 * scripts/setup-whisper.js — one-command local transcription setup.
 *
 *   npm run setup-whisper              (small model, ~466 MB — recommended)
 *   npm run setup-whisper-gpu          (CUDA build — runs on an NVIDIA GPU)
 *   npm run setup-whisper -- --model=base   (~142 MB, faster, less accurate)
 *   npm run setup-whisper -- --gpu --model=medium
 *
 * Downloads the whisper.cpp Windows binary (from the official GitHub
 * release) into ./bin and a ggml model (from the official Hugging Face
 * repo) into ./models. After this, transcription is local, free, and has
 * NO rate limits — Groq is only used if these files are missing.
 *
 * --gpu fetches the CUDA (cuBLAS) build, which runs on an NVIDIA card (e.g. an
 * RTX 3050) for ~5-10x faster transcription. It bundles the CUDA runtime DLLs
 * it needs; you only need a current NVIDIA driver. If the latest release has no
 * CUDA build, it falls back to the CPU build automatically.
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

async function latestWindowsAsset(gpu) {
  const res = await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest", {
    headers: { "User-Agent": "edit-ai-setup", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel = await res.json();
  const assets = rel.assets || [];
  const pick = (re) => assets.find((a) => re.test(a.name));

  let asset = null;
  if (gpu) {
    // CUDA / cuBLAS build — runs on the NVIDIA GPU.
    asset = pick(/cublas.*x64\.zip$/i) || pick(/cuda.*x64\.zip$/i);
    if (!asset)
      console.log("  ! no CUDA build in the latest release — falling back to the CPU build.");
  }
  // CPU build (also the fallback): prefer the plain bin-x64 zip.
  asset =
    asset ||
    pick(/bin-x64\.zip$/i) ||
    pick(/win.*x64.*\.zip$/i) ||
    pick(/x64.*\.zip$/i);
  if (!asset) throw new Error("no Windows x64 zip in the latest release — see manual steps below");
  return {
    url: asset.browser_download_url,
    name: asset.name,
    tag: rel.tag_name,
    isGpu: /cublas|cuda/i.test(asset.name),
  };
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

function findExe(dir, skipPath) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue; // directory vanished mid-walk — skip it, don't crash the install
    }
    for (const f of entries) {
      const p = path.join(d, f);
      if (skipPath && path.resolve(p) === path.resolve(skipPath)) continue; // don't stat the zip we're about to delete
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue; // file vanished between readdir and stat — race-safe skip
      }
      if (st.isDirectory()) stack.push(p);
      else if (/^(whisper-cli|main)(\.exe)?$/i.test(f)) return p;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(BIN, { recursive: true });
  fs.mkdirSync(MODELS, { recursive: true });

  const GPU = process.argv.includes("--gpu") || process.argv.includes("--cuda");

  // 1) binary
  const already = ["whisper-whisper-cli.exe", "whisper-cli.exe", "whisper-cli", "main.exe", "main"]
    .map((f) => path.join(BIN, f))
    .find((p) => fs.existsSync(p));
  // --gpu always (re)fetches, so an existing CPU build gets swapped for the CUDA one.
  if (already && !GPU) {
    console.log(`✓ whisper binary already present: ${already}`);
  } else if (process.platform === "win32") {
    if (GPU) console.log("Requesting the CUDA (GPU) build…");
    const asset = await latestWindowsAsset(GPU);
    const zip = path.join(BIN, asset.name);
    await download(asset.url, zip, `whisper.cpp ${asset.tag} (${asset.name})`);
    extractZip(zip, BIN);
    // Find (and copy into place) the binary FIRST, skipping the zip itself
    // during the walk. Only delete the zip once we're completely done
    // reading the directory — never concurrently with the scan.
    const exe = findExe(BIN, zip);
    if (!exe) throw new Error("binary zip extracted but no whisper-cli.exe/main.exe found");
    // Bring the binary AND its sibling DLLs (the CUDA runtime lives right next
    // to the exe) up to BIN root, so whisper-cli.exe finds them at runtime.
    const exeDir = path.dirname(exe);
    if (path.resolve(exeDir) !== path.resolve(BIN)) {
      for (const f of fs.readdirSync(exeDir)) {
        try {
          const src = path.join(exeDir, f);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(BIN, f));
        } catch {}
      }
    }
    const target = path.join(BIN, "whisper-cli.exe");
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(BIN, path.basename(exe)), target);
    console.log(`✓ binary ready: ${target}${asset.isGpu ? "  (CUDA / GPU build ⚡)" : "  (CPU build)"}`);
    if (GPU && !asset.isGpu)
      console.log("  Note: CPU build installed (no CUDA build was available). Transcription still works, just on CPU.");
    if (asset.isGpu)
      console.log("  The CUDA build uses your NVIDIA GPU automatically. Needs a current NVIDIA driver;\n  the CUDA runtime DLLs are bundled in this zip (kept next to whisper-cli.exe).");
    try {
      fs.unlinkSync(zip);
    } catch {
      /* leftover zip is harmless — the app never reads it */
    }
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

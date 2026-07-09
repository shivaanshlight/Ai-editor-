/**
 * lib/embed.js — local text embeddings via Transformers.js (gte-small, 384-dim).
 * Free, no API key, runs on-machine. The model (~90 MB) downloads once on first
 * use and is cached; after that it works offline.
 *
 * Transformers.js is ESM, so it's loaded with a dynamic import from CommonJS.
 */
let _extractor = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  const { pipeline, env } = await import("@xenova/transformers");
  // Keep the downloaded model inside the project so it persists between runs.
  env.cacheDir = require("path").join(__dirname, "..", ".models");
  _extractor = await pipeline("feature-extraction", "Xenova/gte-small");
  return _extractor;
}

/** Embed an array of strings → array of 384-float unit vectors. */
async function embed(texts) {
  if (!texts.length) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

const EMBED_DIM = 384;

module.exports = { embed, EMBED_DIM };

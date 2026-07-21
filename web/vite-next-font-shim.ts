// Shim for `next/font/google` in the Vite single-file build. The real fonts are
// loaded via a <link> in vite-index.html and exposed as CSS vars, so these just
// need to return the shape layout code reads without doing any font loading.
export function Inter(_opts?: any) {
  return { variable: "font-inter", className: "font-inter", style: { fontFamily: "var(--font-sans)" } };
}
export function JetBrains_Mono(_opts?: any) {
  return { variable: "font-jbmono", className: "font-jbmono", style: { fontFamily: "var(--font-mono)" } };
}

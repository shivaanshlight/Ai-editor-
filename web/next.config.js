/** @type {import('next').NextConfig} */
// Static export: `next build` emits a self-contained site into web/out, which
// the Express backend (server.js) serves directly. One server, one port, no
// second process. Every /api/* call is same-origin, so no proxy/CORS needed.
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: false,
};

module.exports = nextConfig;

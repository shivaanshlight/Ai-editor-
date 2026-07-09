/** @type {import('next').NextConfig} */
const API = process.env.CLIPSURGEON_API || "http://localhost:3000";

// The React app runs on :3001; the Express backend (server.js) runs on :3000.
// Every /api/* call and the media/preview/source routes are proxied to Express
// so the browser talks to one origin and there are no CORS headaches.
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
    ];
  },
};

module.exports = nextConfig;

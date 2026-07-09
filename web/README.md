# edit.ai — web frontend (Next.js)

A production React/Next.js frontend for the edit.ai video editor. It renders the
whole UI and talks to the existing Express backend (`../server.js`) through a
same-origin proxy, so there are no CORS headaches.

## How it runs (two processes)

The backend (API + ffmpeg render engine) and the frontend are separate:

| Process | Command | Port |
|---|---|---|
| **Backend** (Express) | `node server.js` (in the repo root) | **3000** |
| **Frontend** (Next.js) | `npm run dev` (in `web/`) | **3001** |

Every `/api/*`, `/api/preview/*`, `/api/source/*` request the browser makes to
:3001 is transparently proxied to the backend on :3000 (see `next.config.js`).

## First-time setup

```bash
# 1. Backend deps (repo root) — once
npm install

# 2. Frontend deps (this folder) — once
cd web
npm install
```

## Every time you work

```bash
# terminal 1 — the render backend
node server.js

# terminal 2 — the UI
cd web
npm run dev
```

Then open **http://localhost:3001**.

## Config

- The backend port is assumed to be 3000. If you run it elsewhere, set
  `CLIPSURGEON_API` before starting Next, e.g.
  `CLIPSURGEON_API=http://localhost:4000 npm run dev`.
- Theme (dark/light) is remembered in `localStorage`.

## Production build

```bash
cd web
npm run build && npm start   # serves the optimized app on :3001
```

## What's where

```
web/
  app/
    layout.tsx        root layout, fonts, no-flash theme init
    page.tsx          the state machine: mode → upload → progress → review/result
    globals.css       the design system (CSS variables + primitives)
  components/
    Nav, Dropzone, AiConfig, ClipsConfig, SilenceConfig
    Progress          non-interactive phase status + bar
    Review            per-word cut/keep blocks + plan card
    Timeline          the editor: trim / split / delete / zoom / scrub
    ClipReview, ClipEditor, ClipsResult
    Result            preview + versions + stats + timeline + content kit
    ContentKit        titles/description/tags/chapters/quotes/social
    Search            semantic "find a moment by meaning"
  lib/
    types, api, settings, format, useJob (polling hook)
```

Switching modes in the top bar always returns to that mode's own upload screen —
one feature's result never bleeds into another.

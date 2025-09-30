# SciTeller (Frontend + Backend + Auth API)

## Overview
Monorepo with:
- **frontend**: SPA (Vite) served by Nginx
- **backend**: FastAPI service (document parsing, orchestrates remote LLM API)
- **auth-api**: Next.js + NextAuth (Google/GitHub OAuth) with PostgreSQL via Drizzle ORM
- **docker-compose.yml** to run everything locally

The heavy LLM models live in a **separate GPU service** (see the other repo, “vm-api”).

## Architecture
- Browser → Nginx (frontend)  
  - `/api/*` → **auth-api** (Next.js API & NextAuth)
  - `/svc/*` → **backend** (FastAPI)
- **backend** calls the remote GPU API (`REMOTE_GPU_URL`) for splitting/storytelling.

## Repo Structure
```
/AIScientistStoryteller   # frontend (Vite)
  └─ nginx.conf
/backend                  # FastAPI app
  └─ vendor/… (vendored deps)
/auth-api                 # Next.js + NextAuth + Drizzle
docker-compose.yml
.env.example              # project-level env template
```

## Prerequisites
- Docker & Docker Compose
- A PostgreSQL instance reachable by `auth-api`
- OAuth app credentials (Google and/or GitHub)

## Environment Variables
Create **`.env` at repo root** based on `.env.example`.  
Also create per-app envs if needed:
- `AIScientistStoryteller/.env` (Vite)
- `auth-api/.env` (NextAuth/DB)
- `backend/.env` (FastAPI)

> Never commit real secrets. Only commit the provided `*.env.example`.

## Quick Start (Docker)
```bash
docker compose build
docker compose up
# Frontend: http://localhost:8080
# Backend (behind nginx proxy): http://localhost:8080/svc/health
# Auth API (behind nginx proxy): http://localhost:8080/api/health (if implemented)
```

### Health checks (direct containers)
- Frontend (Nginx): `GET http://localhost:8080/`
- Backend: `GET http://backend:8000/health`
- Auth API (example): `GET http://authapi:3000/api/…`

## Database (auth-api)
Drizzle migrations are committed in `auth-api/drizzle/`.

Run migrations:
```bash
# host
cd auth-api
npm ci
npm run drizzle:migrate

# or via docker
docker compose run --rm authapi npm run drizzle:migrate
```

## Nginx Frontend Proxy
`AIScientistStoryteller/nginx.conf`:
- `/api/ → authapi:3000`
- `/svc/ → backend:8000`
- Static files served from `/usr/share/nginx/html`

## Development Tips
- Frontend dev (optional): `cd AIScientistStoryteller && npm ci && npm run dev`
- Backend local: `cd backend && uvicorn app:app --reload`
- Auth API local: `cd auth-api && npm ci && npm run dev`

## Security & Secrets
- Do **not** commit `.env` files.
- Rotate `NEXTAUTH_SECRET`, `AUTH_SECRET`, and OAuth credentials in production.

## Troubleshooting
- Models are **not** in this repo. The backend talks to the **GPU API** via `REMOTE_GPU_URL`.
- CORS: set `ALLOWED_ORIGINS` in `backend/.env` if needed.
- DB: verify `DATABASE_URL` points to your PostgreSQL.

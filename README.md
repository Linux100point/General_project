# University project skeleton

This repository contains a minimal full-stack app foundation for a university project.

## Project structure

- `frontend/` — Vite + React + TypeScript app
- `backend/` — Express + TypeScript API
- `.env.example` — environment variable template for Supabase

## Environment variables

Copy `.env.example` to `.env` in the project root and fill in your Supabase values.

## Run frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend will be available at http://localhost:5173

## Run backend

```bash
cd backend
npm install
npm run dev
```

Backend will be available at http://localhost:3001

## Health check

- Frontend loads the backend endpoint `/api/health`
- Backend responds with `{ "status": "ok" }`

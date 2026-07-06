# Routelag Stationary Server

Companion API for **PathGen replay parsing** and small RouteLag utilities. This is **not** the RouteLag routing VPS.

Repository: [github.com/WrenchDevelops/Routelag-Stationary-Server-bot](https://github.com/WrenchDevelops/Routelag-Stationary-Server-bot)

## Deploy on Railway

1. Create a Railway project from this GitHub repo.
2. Set the service root to `/` (repo root).
3. Add environment variables from `.env.example`:
   - `OSIRION_API_KEY` (required for replay parsing)
   - `PATHGEN_AUTH_SECRET`
   - `PATHGEN_INVITE_CODES`
4. Optional: mount a volume at `/app/data` for persistent replay job storage.
5. Railway sets `PORT` automatically; `railway.toml` handles build/start.

## Local dev

```bash
cp .env.example .env
npm install
npm run dev
```

Default: `http://127.0.0.1:8788`

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Service health |
| `POST /api/auth/login` | Beta invite login |
| `POST /api/replays/upload` | Upload `.replay` file |
| `GET /api/replays/jobs` | List parse jobs |
| `GET /api/replays/jobs/:id` | Job status (polls Osirion) |
| `GET /api/replays` | Parsed replay summaries |
| `GET /api/replays/:id` | Full parsed replay |

Discord bot code will live in `src/discord/`.

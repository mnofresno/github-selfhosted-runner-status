# GitHub Runner Fleet

Self-hosted GitHub Actions runner manager with a React + TypeScript dashboard and an Express backend written in TypeScript.

## Architecture

```text
┌──────────────────────────────────┐
│ runner-status (Node.js)          │
│ ┌──────────────┐ ┌─────────────┐ │
│ │ React SPA    │ │ CRUD API    │ │
│ │ (compiled)   │ │ /api/...    │ │
│ └──────────────┘ └─────────────┘ │
│          │                       │
│     Docker Socket                │
│          │                       │
│ ┌────────▼─────────────────────┐ │
│ │ Persistent Runner Stacks     │ │
│ │ ┌─────────┐ ┌─────────────┐ │ │
│ │ │ Runner  │ │ DinD        │ │ │
│ │ │ (always │ │ (always     │ │ │
│ │ │  on)    │ │  on)        │ │ │
│ │ └─────────┘ └─────────────┘ │ │
│ └─────────────────────────────┘ │
└──────────────────────────────────┘
```

Runners are persistent. They stay connected to GitHub all the time, and the UI is now a compiled client app instead of inline HTML rendered from the backend.

## Files

- `frontend/`: React + TypeScript dashboard source
- `status-app/server.ts`: Docker orchestration, GitHub API integration, Express routes, and static asset serving
- `status-app/cleanup.ts`: cleanup logic for stale managed resources
- `docker-compose.yml`: production-oriented container setup
- `Dockerfile`: multi-stage image build for the frontend bundle and compiled backend runtime

## Quick Start

```bash
cp .env.example .env
# edit .env and set ACCESS_TOKEN / RUNNER_TARGETS_JSON
npm ci
npm run build
npm start
```

For the same path used in production:

```bash
docker compose up -d --build
```

Visit `http://localhost:3571`.

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ACCESS_TOKEN` | — | GitHub PAT with runner administration access |
| `RUNNER_IMAGE` | `myoung34/github-runner:latest` | Docker image for runners |
| `DIND_IMAGE` | `docker:27-dind` | Docker-in-Docker image |
| `RUNNERS_PER_TARGET` | `1` | Default runner count per target |
| `HEALTHCHECK_INTERVAL_MS` | `15000` | How often to check runner health |
| `STATUS_BIND` | `127.0.0.1:3571` | Dashboard bind address |
| `LABELS` | `self-hosted,linux,x64` | Default runner labels |
| `FLEET_CACHE_VOLUME` | — | Optional Docker volume to mount into runner containers for `/cache` workflows |
| `FLEET_CACHE_MOUNT_PATH` | `/cache` | Mount path used inside runners when `FLEET_CACHE_VOLUME` is set |

### Target Configuration

Targets can be configured two ways:

1. Via UI in the dashboard.
2. Via `RUNNER_TARGETS_JSON` in `.env` and imported on first startup.

Example target:

```json
{
  "id": "my-org",
  "name": "My Org Fleet",
  "scope": "org",
  "owner": "my-github-org",
  "repo": "my-app",
  "labels": ["self-hosted", "linux", "x64"],
  "runnersCount": 1,
  "runnerGroup": "Default",
  "description": "Runners for my org"
}
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | React dashboard |
| `GET` | `/api/status` | Full fleet status JSON |
| `POST` | `/api/targets` | Add a new target |
| `DELETE` | `/api/targets/:id` | Remove a target and stop its runners |
| `POST` | `/api/targets/:id/restart` | Restart runners for a target |
| `GET` | `/api/targets/:id/runs/:runId/jobs` | List jobs for a run |
| `POST` | `/api/targets/:id/runs/:runId/rerun` | Rerun a workflow |
| `POST` | `/api/targets/:id/runs/:runId/rerun-failed` | Retry failed jobs |
| `POST` | `/api/targets/:id/jobs/:jobId/rerun` | Rerun a single job |

## CI/CD

- `CI` runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
- `Deploy` runs the same verification on pushes to `main` and then triggers the existing production auto-deploy.
- Production now builds the frontend bundle into the container image and serves it from the Node runtime.

## Build Cache

The fleet build cache described in `docs/build-cache/README.md` is opt-in.

If you want self-hosted runners launched by this fleet to expose `/cache`, set `FLEET_CACHE_VOLUME=fleet-cache-global` in `.env`, run `sudo bash scripts/setup-cache-host.sh`, and restart the fleet. If you leave that unset, the fleet behaves exactly as before.

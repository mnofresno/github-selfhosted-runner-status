# github-selfhosted

Minimal self-hosted GitHub Actions runner stack with:

- a Dockerized self-hosted runner container
- a tiny Node status app that shows runner state and recent workflow runs
- force-cancel support for the active workflow run
- rerun controls for an entire run, only failed jobs, or a specific past job
- idle-time cleanup of dangling Docker images, volumes, and build cache
- `docker-compose.yml` for deployment

## Files

- `docker-compose.yml`: runner and status app services
- `status-app/server.js`: GitHub API polling and HTML rendering
- `status/index.html`: static fallback page
- `.env.example`: required environment variables without secrets
- no server-specific nginx, hostnames, or private infrastructure config

## Environment

Copy `.env.example` to `.env` and fill:

- `REPO_URL`
- `ACCESS_TOKEN`
- `RUNNER_NAME`
- `RUNNER_WORKDIR`
- `LABELS`
- `STATUS_PORT`
- `COMPOSE_PROJECT_NAME`
- `RUNNER_IMAGE`
- `CLEANUP_COOLDOWN_MS`
- `CLEANUP_DANGLING_MAX_AGE`
- `CLEANUP_BUILD_CACHE_MAX_AGE`

## Run

```bash
docker compose up -d
```

When the runner is idle, the status app prunes dangling Docker images, dangling volumes, and old build cache through the Docker socket. Cleanup is skipped while the runner is busy or while a workflow run is still active.

## Notes

- `myoung34/github-runner` is a third-party image, not an official GitHub image.
- GitHub's official runner software lives in `actions/runner`, but GitHub does not provide an official Docker image for this use case.
- The compose file stays generic on purpose. It should not include your real domain, nginx vhost, server paths, or secrets.
- If someone clones this repo, they can run the stack locally or behind their own reverse proxy. A server-specific nginx file from your machine would not be reusable for them and would leak infrastructure details.
- GitHub Actions supports rerunning a full run, rerunning failed jobs, and rerunning a specific job.
- GitHub Actions does not expose a clean official API to cancel only one job while keeping the rest of the run alive.
- `EPHEMERAL=true` makes the runner deregister after each job so one long-lived container does not accumulate stale runner state forever.

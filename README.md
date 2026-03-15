# github-runner-fleet

Small Docker-based fleet manager for GitHub Actions runners.

It keeps one baseline runner service in Compose and exposes a local UI that can:

- launch extra ephemeral runners per target
- show Docker-managed runner containers and GitHub-registered runners side by side
- show run controls for repo-scoped targets
- support both repo-scoped and org-scoped runner targets

## Files

- `docker-compose.yml`: baseline runner plus the local fleet UI
- `status-app/server.js`: GitHub API polling, Docker orchestration, HTML rendering
- `status/index.html`: static fallback page
- `.env.example`: sample environment
- `docker-compose.override.example.yml`: sample persistent runner services for critical orgs

## Environment

Use `RUNNER_TARGETS_JSON` to define the fleet:

```json
[
  {
    "id": "bpf-org",
    "name": "BPF Shared Org Fleet",
    "scope": "org",
    "owner": "bpf-project",
    "runnerGroup": "Default",
    "labels": ["self-hosted", "linux", "x64", "bpf-org", "shared"]
  },
  {
    "id": "gymnerd-org",
    "name": "GymNerd Org Fleet",
    "scope": "org",
    "owner": "gymnerd-ar",
    "runnerGroup": "Default",
    "labels": ["self-hosted", "linux", "x64", "gymnerd", "shared"]
  },
  {
    "id": "ops-repo",
    "name": "Ops Repo",
    "scope": "repo",
    "owner": "mnofresno",
    "repo": "github-runner-fleet",
    "labels": ["self-hosted", "linux", "x64", "ops"]
  }
]
```

Supported fields:

- `id`: stable slug used by the API and UI
- `name`: display name
- `scope`: `repo` or `org`
- `owner`: GitHub owner or organization
- `repo`: required for `repo` scope
- `labels`: extra runner labels
- `runnerGroup`: optional GitHub runner group for org scope
- `description`: optional UI text
- `accessToken`: optional per-target token override
- `runnerImage`: optional image override
- `runnerWorkdir`: optional workdir override

Shared variables:

- `RUNNER_TARGETS_JSON`
- `ACCESS_TOKEN`
- `RUNNER_IMAGE`
- `RUNNER_WORKDIR`
- `STATUS_BIND`
- `STATUS_INTERNAL_PORT`
- `STATUS_PORT`
- `COMPOSE_PROJECT_NAME`

Legacy single-target variables such as `REPO_URL`, `RUNNER_NAME`, and `RUNNER_SCOPE` still work for the baseline compose runner.

## Pragmatic production setup

The fleet UI can launch ephemeral runners per target, but it does not autoscale from queued jobs by itself.

The pragmatic production model is:

- keep one persistent baseline runner for each critical org
- use the fleet UI or API to launch extra ephemeral runners only for burst capacity

That prevents `main` from staying queued while still keeping the burst model available.

Use a local `docker-compose.override.yml` for those extra baseline runners. A sample is included in `docker-compose.override.example.yml`.

Example:

```yaml
services:
  runner-gymnerd:
    image: ${RUNNER_IMAGE:-myoung34/github-runner:latest}
    restart: unless-stopped
    env_file:
      - .env
    environment:
      RUNNER_NAME: gymnerd-org-runner-1
      RUNNER_SCOPE: org
      ORG_NAME: gymnerd-ar
      LABELS: self-hosted,linux,x64,gymnerd,shared
      DISABLE_AUTO_UPDATE: 'true'
      EPHEMERAL: 'true'
      RUNNER_WORKDIR: /tmp/github-runner
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /tmp/github-runner-gymnerd:/tmp/github-runner
```

Then start it with:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up -d runner-gymnerd
```

Each runner is registered in exactly one scope. Do not try to register one persistent runner across multiple organizations.

## Ports

The UI container should listen on an internal numeric port. The host bind is configured separately.

- `STATUS_INTERNAL_PORT=8080`
- `STATUS_BIND=127.0.0.1:3571`
- `STATUS_PORT=8080`

That split avoids the common mistake of passing `127.0.0.1:3571` into the Node process as if it were a listen port.

## Scope choice

Use org-scoped runners when:

- several repos in the same organization should share capacity
- the token has org runner administration permissions
- access through runner groups is acceptable

Use repo-scoped runners when:

- the fleet must stay isolated to one repository
- billing or trust boundaries differ
- you need run-level controls tied to exactly one repository

## Run

```bash
docker compose up -d
```

## GitHub permissions

The token used by a target needs runner administration at the same scope:

- repo-scoped: repository self-hosted runner admin access
- org-scoped: organization self-hosted runner admin access

If one token does not cover every org, set `accessToken` per target.

## Notes

- `myoung34/github-runner` is a third-party image.
- The UI keeps backward compatibility with legacy Docker labels from the old `github-selfhosted` naming so old managed containers can still be listed and removed after the rename.

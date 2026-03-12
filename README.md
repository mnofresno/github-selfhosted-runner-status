# github-selfhosted

Minimal self-hosted GitHub Actions runner stack with:

- a baseline Dockerized self-hosted runner container
- a Node status app that can launch and remove additional ephemeral runners
- support for multiple runner targets across repos and organizations
- status visibility for local managed containers and GitHub-registered runners
- run controls for repo-scoped targets: force-cancel, rerun all, rerun failed, inspect jobs

## Files

- `docker-compose.yml`: baseline runner plus the status app
- `status-app/server.js`: GitHub API polling, Docker orchestration, and HTML rendering
- `status/index.html`: static fallback page
- `.env.example`: sample environment variables

## Environment

Use `RUNNER_TARGETS_JSON` to define the fleet the UI can launch.

Example:

```json
[
  {
    "id": "bpf-application",
    "name": "BPF Application",
    "scope": "repo",
    "owner": "bpf-project",
    "repo": "bpf-application",
    "labels": ["self-hosted", "linux", "x64", "bpf"]
  },
  {
    "id": "gymnerd-bot",
    "name": "GymNerd Bot",
    "scope": "repo",
    "owner": "gymnerd-ar",
    "repo": "gymnerd-bot",
    "labels": ["self-hosted", "linux", "x64", "gymnerd"]
  },
  {
    "id": "bpf-org-shared",
    "name": "BPF Shared Org Fleet",
    "scope": "org",
    "owner": "bpf-project",
    "runnerGroup": "Default",
    "labels": ["self-hosted", "linux", "x64", "shared"]
  }
]
```

Supported target fields:

- `id`: stable slug used by the API and UI
- `name`: display name
- `scope`: `repo` or `org`
- `owner`: GitHub org or owner
- `repo`: required for `repo` scope
- `labels`: optional labels appended to the runner registration
- `runnerGroup`: optional GitHub runner group name
- `description`: optional UI text
- `accessToken`: optional per-target token override
- `runnerImage`: optional image override
- `runnerWorkdir`: optional workdir override

Global environment variables:

- `RUNNER_TARGETS_JSON`
- `ACCESS_TOKEN`: optional default token reused by targets that omit `accessToken`
- `REPO_URL`: still used by the baseline compose runner if you keep that service enabled
- `RUNNER_NAME`: still used by the baseline compose runner
- `RUNNER_IMAGE`
- `RUNNER_WORKDIR`
- `STATUS_PORT`
- `COMPOSE_PROJECT_NAME`

Legacy single-target variables such as `REPO_URL`, `ACCESS_TOKEN`, and `RUNNER_NAME` still work as a fallback and remain useful for the baseline compose runner. `RUNNER_TARGETS_JSON` is the preferred path for the UI-managed fleet.

## Recommendation

Default to repo-scoped runners when you need isolation across organizations or billing boundaries.

Use org-scoped runners only when:

- the same trusted organization owns all target repos
- you want one shared fleet and broader repository access is acceptable
- you are comfortable managing runner groups at the org level

For your setup, the pragmatic default is:

- `bpf-project/bpf-application`: repo-scoped
- `gymnerd-ar/gymnerd-bot`: repo-scoped
- optional shared org-scoped targets later, only if several repos inside the same org truly need the same fleet

## Run

```bash
docker compose up -d
```

The status app keeps the baseline runner service, but the UI can now launch extra ephemeral runners on demand. Those launched containers are labeled, visible in the UI, and removable without touching the baseline service.

## GitHub permissions

The token used by each target needs enough permission to register runners at that scope:

- repo-scoped: repository admin access for self-hosted runners
- org-scoped: org-level runner administration permissions

If one token does not cover every organization, set `accessToken` per target.

## Notes

- `myoung34/github-runner` is a third-party image, not an official GitHub image.
- GitHub's official runner software lives in `actions/runner`, but GitHub does not provide an official Docker image for this use case.
- Org-scoped targets do not expose a single cross-repo workflow run feed, so run-level controls stay repo-scoped.

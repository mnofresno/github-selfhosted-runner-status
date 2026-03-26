# Fleet Build Cache System

A build artifact cache system for GitHub Actions runners that allows sharing build artifacts between CI jobs and deploy processes without changing existing fleets by default.

## Quick Start

1. **Setup cache volume**:
   ```bash
   sudo ./scripts/setup-cache-host.sh
   ```

2. **Opt into runner mounts** by setting `FLEET_CACHE_VOLUME=fleet-cache-global` in `.env`.

3. **Restart github-runner-fleet**:
   ```bash
   docker compose up -d --build
   ```

4. **Test the cache**:
   ```bash
   ./scripts/test-cache-integration.sh
   ```

## Integration Examples

### GitHub Actions Workflow
```yaml
- name: Try to fetch cached build
  run: |
    if /cache/scripts/fetch.sh "${{ github.repository }}" "./cached" --commit="${{ github.sha }}"; then
      echo "Using cached build"
      cp -r cached/* ./dist/
    else
      echo "Building fresh"
      npm run build
      /cache/scripts/store.sh "${{ github.repository }}" "${{ github.sha }}" "./dist"
    fi
```

### git-autodeploy Integration
```yaml
post_fetch_commands:
  - |
    if /var/cache/fleet/scripts/fetch.sh "owner/repo" "/tmp/cache-build"; then
      echo "Using cached build"
      cp -r /tmp/cache-build/* ./dist/
    else
      echo "Building fresh"
      npm run build
      /var/cache/fleet/scripts/store.sh "owner/repo" "$(git rev-parse HEAD)" "."
    fi
```

## Script Reference

### `store.sh`
Store build artifacts in cache.
```bash
/cache/scripts/store.sh <project-id> <commit-sha> <source-path> [--keep-last=N]
```

### `fetch.sh`
Fetch build artifacts from cache.
```bash
/cache/scripts/fetch.sh <project-id> <target-path> [--commit=<sha>]
```

### `cleanup.sh`
Clean old builds.
```bash
/cache/scripts/cleanup.sh --project=<project-id> --keep-last=N
/cache/scripts/cleanup.sh --all-projects --keep-last=10
```

### `info.sh`
Show cache statistics.
```bash
/cache/scripts/info.sh [--project=<project-id>] [--details]
```

## Architecture

- **Volume**: `fleet-cache-global` mounted at `/cache` only when `FLEET_CACHE_VOLUME` is configured
- **Organization**: `projects/<owner>/<repo>/builds/<commit-sha>/`
- **Hard links**: Used when source and destination are on same filesystem
- **Locking**: Prevents concurrent access to same project cache
- **Cleanup**: Automatic cleanup of old builds (keep last N)

## Benefits

1. **Faster deploys**: Skip rebuilds when cache hit
2. **Reduced resource usage**: Less CPU/memory for builds
3. **Consistency**: Same artifacts in CI and production
4. **Space efficient**: Hard links reduce storage duplication
5. **Simple integration**: Drop-in scripts for existing workflows
6. **Backward compatible**: no effect on fleets that do not opt in

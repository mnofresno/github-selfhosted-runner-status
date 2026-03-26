# PR #1: MVP Build Artifact Cache with Hard Links

## Overview
Implements a build artifact cache system for GitHub Actions runners that allows sharing build artifacts between CI jobs and deploy processes to avoid redundant rebuilds.

## Changes Included

### 1. Core Cache System (`scripts/cache-utils/`)
- **`common.sh`**: Shared functions (validation, locking, cleanup)
- **`store.sh`**: Store artifacts with hard links (falls back to copy)
- **`fetch.sh`**: Fetch artifacts with hard links  
- **`cleanup.sh`**: Clean old builds (keep-last=N)
- **`info.sh`**: Show cache statistics
- **`init-volume.sh`**: Initialize volume structure

### 2. Runner Integration (`status-app/server.js`)
- Modified `buildRunnerContainerSpec()` to mount cache volume at `/cache` in runners
- All runner containers now have access to shared cache volume

### 3. Docker Compose Configuration
- Added `fleet-cache-global` volume to `docker-compose.yml`
- Volume mounted at `/cache` in runner-status container

### 4. Reusable GitHub Action
- Created `.github/workflows/reusable-cache.yml`
- Supports `store`, `fetch`, `info` operations
- Outputs cache hit/size/commit information

### 5. Host Setup Script
- `scripts/setup-cache-host.sh`: Creates volume and deploys scripts
- Sets permissions for git-autodeploy (www-data user)

### 6. Documentation
- `QUICKSTART.md`: 5-minute setup guide
- `INTEGRATION-BPF-APPLICATION.md`: bpf-application integration
- Example workflows and configurations

## Key Features
- **Hard links for efficiency**: Uses hard links when possible (same filesystem)
- **Space-efficient**: Only stores unique file content
- **Project isolation**: Cache organized by `owner/repo` project IDs
- **Automatic cleanup**: Keeps last N builds per project
- **Locking**: Prevents concurrent access conflicts
- **Portable**: Works with Alpine/busybox containers

## Testing
- Created `scripts/test-cache-integration.sh` to verify functionality
- All core operations tested: store, fetch, cleanup, info
- Compatible with Alpine containers (no bash, no flock -w)

## Integration Points
1. **GitHub Actions**: Use reusable action in workflows
2. **git-autodeploy**: Call scripts from `.git-auto-deploy.yaml`
3. **Manual use**: Run scripts directly from `/cache/scripts/`

## Next Steps (Future PRs)
- PR #2: Integration with runners + optimization
- PR #3: System of layers (Docker-style deduplication)
- PR #4: Compression adaptive (optional)
- PR #5: UI integration + monitoring

## Performance Impact
- **Build time**: Potential 1-2 minute savings per deploy for bpf-application
- **Storage**: Hard links reduce duplicate file storage
- **Memory**: Minimal overhead (simple bash scripts)
- **CPU**: Negligible impact (file copying operations only)
# Fleet Build Cache - Quick Start Guide

## Overview

Fleet Build Cache is a shared artifact caching system for GitHub Actions runners. It allows projects to cache build artifacts between CI jobs and deploy processes, avoiding redundant rebuilds.

## Architecture

```
┌─────────────────┐    Hard Links    ┌─────────────────┐
│   CI Runners    │◄────────────────►│  Cache Volume   │
│  (containers)   │                  │ (fleet-cache-   │
│                 │                  │   global)       │
└─────────────────┘                  └────────┬────────┘
                                              │ Hard Links
                                              ▼
                                       ┌─────────────────┐
                                       │     Host        │
                                       │ (git-autodeploy)│
                                       └─────────────────┘
```

## Quick Start (5 minutes)

### Step 1: Setup Cache Volume on Host

```bash
# On your host machine (where git-autodeploy runs)
cd /path/to/github-runner-fleet
sudo bash scripts/setup-cache-host.sh
```

This will:
- Create Docker volume `fleet-cache-global`
- Link it at `/var/cache/fleet` on host
- Deploy cache scripts
- Set proper permissions

### Step 2: Opt Into Runner Cache Mounts

```bash
cd /var/www/github-runner-fleet
printf '\nFLEET_CACHE_VOLUME=fleet-cache-global\n' >> .env
docker compose up -d --build
```

### Step 3: Test the Setup

```bash
# Check cache status
fleet-cache-info

# Or directly
/var/cache/fleet/scripts/info.sh
```

## Integrating with Your Project

### Option A: Manual Script Usage

#### In CI Workflow (.github/workflows/push.yml):
```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
    steps:
      - uses: actions/checkout@v4
      - name: Build and cache
        run: |
          # Build your project
          npm run build
          
          # Store in cache
          /cache/scripts/store.sh \
            "${{ github.repository }}" \
            "${{ github.sha }}" \
            "./dist"
```

#### In Deploy (.git-auto-deploy.yaml):
```yaml
post_fetch_commands:
  # Try to fetch cached build
  - if /var/cache/fleet/scripts/fetch.sh "$(basename $(pwd))" "/tmp/cached-build"; then
      echo "Using cached build";
      rm -rf ./dist;
      cp -r /tmp/cached-build/* ./dist/;
    else
      echo "Building fresh";
      npm run build;
    fi
```

### Option B: Using Reusable GitHub Action

#### In CI Workflow:
```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: npm run build
      - name: Cache artifacts
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache.yml@main
        with:
          operation: store
          project_id: ${{ github.repository }}
          source_path: ./dist
          cache_key: ${{ github.sha }}
```

## Examples for Specific Projects

### bpf-application (Next.js)

#### .github/workflows/push.yml:
```yaml
jobs:
  frontend-check:
    steps:
      - name: Try to fetch cached build
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache.yml@main
        with:
          operation: fetch
          project_id: ${{ github.repository }}/frontend
          target_path: ./.next-cache
      
      - name: Build if cache miss
        if: ${{ needs.cache.outputs.cache_hit == 'false' }}
        working-directory: frontend
        run: bun run build
        
      - name: Store to cache (if on main)
        if: ${{ github.ref == 'refs/heads/main' && needs.cache.outputs.cache_hit == 'false' }}
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache.yml@main
        with:
          operation: store
          project_id: ${{ github.repository }}/frontend
          source_path: ./.next
          cache_key: ${{ github.sha }}
```

#### .git-auto-deploy.yaml:
```yaml
post_fetch_commands:
  # Try cached build first
  - if /var/cache/fleet/scripts/fetch.sh "bpf-project/bpf-application/frontend" "/tmp/next-cache"; then
      echo "Using cached Next.js build";
      rm -rf frontend/.next;
      cp -r /tmp/next-cache frontend/.next;
    else
      echo "Building fresh";
      docker compose run --rm --no-deps frontend sh /usr/src/app/scripts/build-production.sh;
    fi
```

### gymnerd-bot (React/Vite)

#### .git-auto-deploy.yaml:
```yaml
post_fetch_commands:
  # ... existing commands ...
  # Build frontend (updated)
  - if /var/cache/fleet/scripts/fetch.sh "gymnerd-ar/gymnerd-bot" "/tmp/frontend-cache"; then
      echo "Using cached frontend build";
      rm -rf public/dist;
      cp -r /tmp/frontend-cache/* public/dist/;
    else
      echo "Building fresh";
      bash bin/build-frontend.sh;
    fi
```

## Maintenance

### Checking Cache Status
```bash
# Overall status
fleet-cache-info

# Specific project
fleet-cache-info --project=owner/repo --details

# With scripts
/var/cache/fleet/scripts/info.sh --project=owner/repo
```

### Cleaning Old Builds
```bash
# Keep last 5 builds per project
fleet-cache-cleanup --all-projects --keep-last=5

# Clean specific project
fleet-cache-cleanup --project=owner/repo --keep-last=3

# Dry run (see what would be deleted)
fleet-cache-cleanup --all-projects --keep-last=5 --dry-run
```

### Manual Operations
```bash
# Store artifacts manually
/var/cache/fleet/scripts/store.sh owner/repo abc123 ./dist

# Fetch artifacts manually  
/var/cache/fleet/scripts/fetch.sh owner/repo ./target-path

# Fetch specific commit
/var/cache/fleet/scripts/fetch.sh owner/repo ./target-path --commit=def456
```

## Troubleshooting

### "Cache directory not found"
```bash
# Check if volume is mounted
docker volume inspect fleet-cache-global

# Check host mount point
ls -la /var/cache/fleet/

# Restart helper container
docker restart fleet-cache-helper
```

### "Permission denied"
```bash
# Fix permissions
sudo chmod -R 0777 /var/cache/fleet
sudo chown -R www-data:www-data /var/cache/fleet
```

### "Hard links failed"
- This is normal if copying between different filesystems
- The system will fall back to regular copy
- No data loss, just less space-efficient

### Checking Scripts
```bash
# Verify scripts are deployed
ls -la /var/cache/fleet/scripts/

# Test a script
bash /var/cache/fleet/scripts/info.sh
```

## Advanced Configuration

### Environment Variables
```bash
# In runner environment
FLEET_CACHE_DIR=/cache           # Cache mount point
FLEET_CACHE_ENABLED=true         # Enable cache system

# In scripts
export FLEET_CACHE_MAX_BUILDS=20 # Override default (10)
```

### Custom Cleanup Schedule
```bash
# Add to crontab (run daily at 3 AM)
0 3 * * * /var/cache/fleet/scripts/cleanup.sh --all-projects --keep-last=7
```

## Monitoring

Check cache growth:
```bash
# Watch cache size
watch -n 60 'du -sh /var/cache/fleet'

# Monitor with logs
tail -f /var/cache/fleet/scripts/operations.log
```

## Support

For issues or questions:
1. Check `/var/cache/fleet/scripts/` for logs
2. Verify volume is mounted: `docker volume ls`
3. Check permissions: `ls -la /var/cache/fleet`
4. Test manually with example commands above

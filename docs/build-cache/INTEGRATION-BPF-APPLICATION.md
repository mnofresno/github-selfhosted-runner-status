# bpf-application Integration Guide

## Current Problem

bpf-application currently does **double builds**:
1. **CI build**: `bun run build` in frontend-check job
2. **Deploy build**: `scripts/build-production.sh` in git-autodeploy

This wastes time and resources. With Fleet Build Cache, we can:
- **Cache** the build from CI
- **Reuse** it during deploy
- **Save** ~1-2 minutes per deploy

## Integration Steps

### Step 1: Modify CI Workflow

File: `/var/www/bpf-application/.github/workflows/push.yml`

#### Current frontend-check job:
```yaml
frontend-check:
  steps:
    # ... existing steps ...
    - name: Run frontend build (coverage validation)
      working-directory: frontend
      run: bun run build
```

#### Updated version:
```yaml
frontend-check:
  steps:
    # ... existing steps until build ...
    
    - name: Try to fetch cached build
      id: cache-fetch
      uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache.yml@main
      with:
        operation: fetch
        project_id: ${{ github.repository }}/frontend
        target_path: ./frontend/.next-cache
    
    - name: Build if cache miss
      if: steps.cache-fetch.outputs.cache_hit == 'false'
      working-directory: frontend
      run: bun run build
    
    - name: Store to cache (main branch only)
      if: |
        github.ref == 'refs/heads/main' && 
        steps.cache-fetch.outputs.cache_hit == 'false'
      uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache.yml@main
      with:
        operation: store
        project_id: ${{ github.repository }}/frontend
        source_path: ./frontend/.next
        cache_key: ${{ github.sha }}
        keep_last: 5  # Keep last 5 builds for this project
```

### Step 2: Modify Deploy Configuration

File: `/var/www/bpf-application/.git-auto-deploy.yaml`

#### Current:
```yaml
post_fetch_commands:
    - docker compose pull frontend backend notifications group-messages-bridge
    - docker compose run --rm --no-deps frontend sh /usr/src/app/scripts/build-production.sh
    - docker compose up -d
    - ./scripts/cleanup-runtime-artifacts.sh
```

#### Updated:
```yaml
post_fetch_commands:
    - docker compose pull frontend backend notifications group-messages-bridge
    
    # Try to use cached build
    - if /var/cache/fleet/scripts/fetch.sh "bpf-project/bpf-application/frontend" "/tmp/next-cache"; then
        echo "✅ Using cached Next.js build";
        rm -rf frontend/.next;
        cp -r /tmp/next-cache frontend/.next;
        echo "Cached build copied successfully";
      else
        echo "🔨 Building fresh (cache miss)";
        docker compose run --rm --no-deps frontend sh /usr/src/app/scripts/build-production.sh;
      fi
    
    - docker compose up -d
    - ./scripts/cleanup-runtime-artifacts.sh
```

### Alternative: Modified build-production.sh

If you prefer to modify the build script instead:

File: `/var/www/bpf-application/frontend/scripts/build-production.sh`

#### Add at the beginning:
```bash
#!/bin/sh
set -eu

# Try to use cached build first
CACHE_DIR="/var/cache/fleet/projects/bpf-project/bpf-application/frontend/builds/latest"
if [ -d "$CACHE_DIR/artifacts" ]; then
    echo "Using cached Next.js build from $CACHE_DIR"
    rm -rf .next 2>/dev/null || true
    cp -r "$CACHE_DIR/artifacts" .next
    exit 0
fi

echo "Starting production build (cache miss)..."
# ... rest of original script
```

## Testing the Integration

### Test 1: Dry Run
```bash
# On host, test fetch manually
cd /var/www/bpf-application
/var/cache/fleet/scripts/fetch.sh "bpf-project/bpf-application/frontend" "/tmp/test-cache" --dry-run
```

### Test 2: Manual Cache Store
```bash
# After a successful build
cd /var/www/bpf-application/frontend
/var/cache/fleet/scripts/store.sh "bpf-project/bpf-application/frontend" "test-commit" "./.next"
```

### Test 3: Verify Cache
```bash
# Check what's in cache
/var/cache/fleet/scripts/info.sh --project=bpf-project/bpf-application/frontend --details
```

## Expected Results

### Before Cache:
```
CI Job: bun run build ................. 45s
Deploy: build-production.sh ............ 60s
Total build time: 105s
```

### After Cache (cache hit):
```
CI Job: bun run build + store .......... 50s (+5s for storage)
Deploy: fetch from cache ............... 5s
Total build time: 55s (48% reduction)
```

### After Cache (cache miss):
```
CI Job: bun run build + store .......... 50s
Deploy: build-production.sh ............ 60s
Total build time: 110s (similar to before)
```

## Monitoring

### Check Cache Effectiveness:
```bash
# After several deployments
/var/cache/fleet/scripts/info.sh --project=bpf-project/bpf-application/frontend

# Expected output:
# Builds cached: 5
# Total size: 1.2GB
# Latest cached: 2026-03-21T18:30:00Z
```

### Cleanup Policy:
```bash
# Keep last 5 builds (adjust based on needs)
# Add to crontab
0 4 * * * /var/cache/fleet/scripts/cleanup.sh --project=bpf-project/bpf-application/frontend --keep-last=5
```

## Troubleshooting bpf-application Specific Issues

### Issue 1: Next.js cache invalidation
Next.js builds include timestamps and hashes. The cache should still work because:
- Build output is deterministic for same source code
- Runtime doesn't depend on build timestamps
- If issues occur, add `--force` to fetch or invalidate cache

### Issue 2: Node modules changes
If `package.json` or `bun.lockb` changes, the cache becomes invalid. This is correct behavior.

### Issue 3: Build script differences
The CI uses `bun run build` while deploy uses `scripts/build-production.sh`. 
Ensure both produce compatible output.

### Issue 4: File permissions
The cached `.next` directory needs proper permissions:
```bash
# Fix permissions if needed
chmod -R 0755 frontend/.next
chown -R www-data:www-data frontend/.next
```

## Rollback Plan

If issues occur, revert to original:

1. **Revert .github/workflows/push.yml** to original
2. **Revert .git-auto-deploy.yaml** to original  
3. **Clear cache** if corrupted:
   ```bash
   docker volume rm fleet-cache-global
   docker volume create fleet-cache-global
   bash /path/to/setup-cache-host.sh
   ```

## Next Steps After Success

1. **Monitor** for 1 week
2. **Measure** actual time savings
3. **Extend** to other projects (backend, etc.)
4. **Optimize** cache settings based on usage
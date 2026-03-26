# Agent Guide: Integrating Fleet Build Cache in Client Projects

This guide is for AI agents working with client projects to integrate the fleet build cache system. The integration is **completely decoupled** - no changes needed to the `github-runner-fleet` repository itself.

## Quick Integration Template

Copy this template to your client project's workflow:

```yaml
# .github/workflows/ci-with-cache.yml
name: CI with Fleet Cache

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]

jobs:
  build:
    runs-on: [self-hosted, ephemeral]  # Must use fleet runners
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history needed for commit SHA
          
      # === FLEET CACHE INTEGRATION ===
      - name: Fleet Cache - Fetch
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
        with:
          operation: fetch
          project-id: ${{ github.repository }}
          target-path: ./cached-build
          commit-sha: ${{ github.sha }}
        id: cache-fetch
        continue-on-error: true  # Continue if cache miss
      
      - name: Build application
        if: steps.cache-fetch.outputs.cache-hit != 'true'
        run: |
          # Your build commands here
          # Example for Node.js:
          npm ci
          npm run build
          
      - name: Fleet Cache - Store
        if: steps.cache-fetch.outputs.cache-hit != 'true'
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
        with:
          operation: store
          project-id: ${{ github.repository }}
          commit-sha: ${{ github.sha }}
          source-path: ./dist  # Your build output directory
          
      - name: Use cached build
        if: steps.cache-fetch.outputs.cache-hit == 'true'
        run: |
          # Copy cached artifacts to your build directory
          cp -r ./cached-build/* ./dist/
          echo "✅ Using cached build from ${{ steps.cache-fetch.outputs.commit-sha }}"
      # === END FLEET CACHE ===
      
      # Your existing steps continue here
      - name: Run tests
        run: npm test
        
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
```

## Project-Specific Integration Examples

### Next.js/React Application
```yaml
- name: Fleet Cache - Fetch
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: fetch
    project-id: ${{ github.repository }}
    target-path: ./next-cache
    commit-sha: ${{ github.sha }}
    
- name: Build Next.js
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  run: |
    npm ci
    npm run build
    
- name: Fleet Cache - Store
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: store
    project-id: ${{ github.repository }}
    commit-sha: ${{ github.sha }}
    source-path: ./.next  # Next.js build output
    
- name: Use cached Next.js build
  if: steps.cache-fetch.outputs.cache-hit == 'true'
  run: |
    rm -rf ./.next
    cp -r ./next-cache/.next ./
```

### Static Site (Hugo, Jekyll, etc.)
```yaml
- name: Fleet Cache - Fetch
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: fetch
    project-id: ${{ github.repository }}
    target-path: ./site-cache
    commit-sha: ${{ github.sha }}
    
- name: Build static site
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  run: |
    # Hugo example
    hugo --minify
    
- name: Fleet Cache - Store
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: store
    project-id: ${{ github.repository }}
    commit-sha: ${{ github.sha }}
    source-path: ./public  # Hugo output directory
```

### Docker Image Build
```yaml
- name: Fleet Cache - Fetch
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: fetch
    project-id: ${{ github.repository }}
    target-path: ./docker-cache
    commit-sha: ${{ github.sha }}
    
- name: Build Docker image
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  run: |
    docker build -t myapp:${{ github.sha }} .
    
- name: Fleet Cache - Store
  if: steps.cache-fetch.outputs.cache-hit != 'true'
  uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
  with:
    operation: store
    project-id: ${{ github.repository }}
    commit-sha: ${{ github.sha }}
    source-path: .  # Store Dockerfile and context
    include-patterns: "Dockerfile,src/,package.json"  # Only cache relevant files
```

## git-autodeploy Integration

For projects using git-autodeploy, add to `.git-auto-deploy.yaml`:

```yaml
post_fetch_commands:
  - |
    # Try to fetch cached build
    if /var/cache/fleet/scripts/fetch.sh "$(git config --get remote.origin.url | sed 's|.*github.com/||' | sed 's|\.git$||')" "/tmp/cached-build" --commit="$(git rev-parse HEAD)"; then
      echo "✅ Using cached build"
      
      # Copy cached artifacts based on project type
      # Next.js example:
      if [ -d "/tmp/cached-build/.next" ]; then
        rm -rf .next
        cp -r /tmp/cached-build/.next ./
      fi
      
      # Static site example:
      if [ -d "/tmp/cached-build/public" ]; then
        rm -rf public
        cp -r /tmp/cached-build/public ./
      fi
    else
      echo "⚠️ No cache found, building fresh..."
      
      # Your build commands
      npm ci --production
      npm run build
      
      # Store for next time
      /var/cache/fleet/scripts/store.sh "$(git config --get remote.origin.url | sed 's|.*github.com/||' | sed 's|\.git$||')" "$(git rev-parse HEAD)" "."
    fi
```

## Agent Workflow

### 1. Assess Project Type
- **Node.js/Next.js**: Cache `.next/` directory
- **Static site**: Cache `public/`, `_site/`, or `dist/` directory  
- **Docker**: Cache `Dockerfile` and source files
- **Python**: Cache virtual environment or built packages
- **Go**: Cache compiled binaries

### 2. Identify Build Output
```bash
# Check common build directories
ls -la | grep -E "(dist|build|public|_site|.next|out|target|bin)"
```

### 3. Create Minimal Integration
Start with the basic template and customize:
1. Replace `./dist` with actual build directory
2. Adjust build commands
3. Set appropriate `include-patterns` if needed

### 4. Test Integration
```bash
# Simulate cache operations locally (if on fleet host)
docker exec fleet-cache-helper /cache/scripts/info.sh --details
```

## Troubleshooting

### Cache Misses
- Ensure `fetch-depth: 0` in checkout step
- Verify commit SHA is correct: `${{ github.sha }}`
- Check project ID format: `owner/repo`

### Permission Issues
- Cache directory is world-writable (`0777`)
- Runs as same user in containers
- Host mount has www-data permissions for git-autodeploy

### Performance
- First build: No cache (stores)
- Subsequent builds: Cache hit (saves 1-2 minutes)
- Hard links fail across different filesystems (uses copy)

## Output Variables

The reusable action provides:
- `cache-hit`: `true` or `false`
- `commit-sha`: Commit SHA of cached build
- `cache-size`: Human-readable size of cached artifacts
- `artifact-count`: Number of files cached

## Migration from Existing Workflows

**Before** (no cache):
```yaml
- name: Build
  run: npm run build  # Always runs
```

**After** (with cache):
```yaml
- name: Try cache
  uses: reusable-cache@feature/build-artifact-cache
  # ... cache config
  
- name: Build
  if: cache-hit != 'true'
  run: npm run build  # Only runs on cache miss
  
- name: Store cache  
  if: cache-hit != 'true'
  uses: reusable-cache@feature/build-artifact-cache
  # ... store config
```

## Complete Example: bpf-application

```yaml
name: BPF Application CI with Cache

on: [push, pull_request]

jobs:
  build:
    runs-on: [self-hosted, ephemeral]
    
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          
      - name: Fleet Cache - Fetch
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
        with:
          operation: fetch
          project-id: ${{ github.repository }}
          target-path: ./next-cache
          commit-sha: ${{ github.sha }}
        id: cache
        continue-on-error: true
      
      - name: Install and Build
        if: steps.cache.outputs.cache-hit != 'true'
        run: |
          npm ci
          npm run build
          
      - name: Fleet Cache - Store
        if: steps.cache.outputs.cache-hit != 'true'
        uses: mnofresno/github-runner-fleet/.github/workflows/reusable-cache@feature/build-artifact-cache
        with:
          operation: store
          project-id: ${{ github.repository }}
          commit-sha: ${{ github.sha }}
          source-path: ./.next
          keep-last: 5
          
      - name: Use cached build
        if: steps.cache.outputs.cache-hit == 'true'
        run: |
          echo "✅ Cache hit! Using build from ${{ steps.cache.outputs.commit-sha }}"
          rm -rf .next
          cp -r ./next-cache/.next ./
          
      - name: Run tests
        run: npm test
```

## Notes for Agents
- **No changes to github-runner-fleet needed**: Integration is client-side only
- **Backward compatible**: Works alongside existing workflows
- **Progressive enhancement**: Start with cache, fall back to build
- **Monitoring**: Check cache hit rates in workflow summaries
- **Cleanup**: Automatic (keep last N) + manual cleanup available
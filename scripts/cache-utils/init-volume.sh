#!/bin/bash
set -euo pipefail

# Initialize fleet cache volume structure
# This should be run inside the volume mount point

source "$(dirname "$0")/common.sh"

echo "Initializing fleet cache volume structure..."

# Create base directories
ensure_dir "${FLEET_CACHE_DIR}/projects"
ensure_dir "${FLEET_CACHE_DIR}/locks"
ensure_dir "${FLEET_CACHE_DIR}/scripts"
ensure_dir "${FLEET_CACHE_DIR}/tmp"

# Copy scripts to volume
SCRIPT_SOURCE="$(dirname "$0")"
if [ "$SCRIPT_SOURCE" != "${FLEET_CACHE_DIR}/scripts" ]; then
    echo "Copying scripts to volume..."
    cp -r "$SCRIPT_SOURCE"/*.sh "${FLEET_CACHE_DIR}/scripts/"
    chmod +x "${FLEET_CACHE_DIR}/scripts"/*.sh
fi

# Create README
cat > "${FLEET_CACHE_DIR}/README.md" << 'EOF'
# Fleet Build Cache Volume

This volume contains cached build artifacts for GitHub Actions runners.

## Structure

- `projects/` - Cached artifacts organized by project
  - `<owner>/<repo>/` - Project namespace
    - `builds/` - Build artifacts by commit SHA
      - `<commit-sha>/` - Specific build
        - `artifacts/` - Actual build artifacts (hard links)
        - `metadata.json` - Build metadata
      - `latest` - Symlink to latest build
- `locks/` - Lock files for concurrent operations
- `scripts/` - Cache management scripts
- `tmp/` - Temporary files

## Usage

### From CI Runners (mount: /cache):
```bash
# Store artifacts
/cache/scripts/store.sh owner/repo abc123 ./dist

# Fetch artifacts  
/cache/scripts/fetch.sh owner/repo ./target
```

### From Host (mount: /var/cache/fleet):
```bash
# Fetch for deploy
/var/cache/fleet/scripts/fetch.sh owner/repo ./deploy-cache
```

## Maintenance

- Clean old builds: `cleanup.sh --all-projects --keep-last=10`
- Check status: `info.sh`
- Monitor size: `du -sh /cache`

## Notes

- Uses hard links for space efficiency
- Same filesystem required for hard links to work
- Fallback to copy if hard links fail
EOF

# Create example project structure
EXAMPLE_PROJECT="example-org/example-repo"
EXAMPLE_DIR="${FLEET_CACHE_DIR}/projects/${EXAMPLE_PROJECT}/builds/example-commit"
ensure_dir "$(dirname "$EXAMPLE_DIR")"
ensure_dir "${EXAMPLE_DIR}/artifacts"

cat > "${EXAMPLE_DIR}/metadata.json" << 'EOF'
{
  "project": "example-org/example-repo",
  "commit": "example-commit",
  "timestamp": "2026-03-21T00:00:00Z",
  "artifacts": {
    "size_bytes": 0,
    "file_count": 0,
    "source_path": "./example"
  },
  "build_context": {
    "hostname": "example",
    "user": "example"
  }
}
EOF

echo "Volume structure initialized successfully!"
echo ""
echo "Directory structure:"
find "${FLEET_CACHE_DIR}" -type d | sort | sed 's|'${FLEET_CACHE_DIR}'/|  |'

echo ""
echo "Available scripts:"
ls -la "${FLEET_CACHE_DIR}/scripts/"*.sh | sed 's|.*/|  |'

echo ""
echo "To test:"
echo "  ${FLEET_CACHE_DIR}/scripts/info.sh"
echo "  ${FLEET_CACHE_DIR}/scripts/store.sh example-org/example-repo test-commit ./some-path"
echo "  ${FLEET_CACHE_DIR}/scripts/fetch.sh example-org/example-repo ./target-path"
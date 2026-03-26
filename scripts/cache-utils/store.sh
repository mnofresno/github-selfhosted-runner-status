#!/bin/bash
set -euo pipefail

# Store build artifacts in fleet cache with hard links
# Usage: store.sh <project-id> <commit-sha> <source-path> [options]

source "$(dirname "$0")/common.sh"

# Parse arguments
if [ $# -lt 3 ]; then
    echo "Usage: $0 <project-id> <commit-sha> <source-path> [options]"
    echo ""
    echo "Options:"
    echo "  --keep-last=N     Keep last N builds (default: 10)"
    echo "  --no-cleanup      Skip cleanup of old builds"
    echo "  --dry-run         Show what would be done without making changes"
    echo ""
    echo "Examples:"
    echo "  $0 bpf-project/bpf-application abc123 ./dist"
    echo "  $0 gymnerd-ar/gymnerd-bot def456 frontend/dist --keep-last=5"
    exit 1
fi

PROJECT_ID="$1"
COMMIT_SHA="$2"
SOURCE_PATH="$3"
shift 3

# Parse options
KEEP_LAST=10
DO_CLEANUP=true
DRY_RUN=false

while [ $# -gt 0 ]; do
    case "$1" in
        --keep-last=*)
            KEEP_LAST="${1#*=}"
            shift
            ;;
        --no-cleanup)
            DO_CLEANUP=false
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Validate inputs
validate_project_id "$PROJECT_ID"

if [ -z "$COMMIT_SHA" ]; then
    error "Commit SHA cannot be empty"
    exit 1
fi

if [ ! -e "$SOURCE_PATH" ]; then
    error "Source path does not exist: $SOURCE_PATH"
    exit 1
fi

# Get cache directories
PROJECT_DIR=$(get_project_cache_dir "$PROJECT_ID")
BUILD_DIR=$(get_build_cache_dir "$PROJECT_ID" "$COMMIT_SHA")
LATEST_SYMLINK=$(get_latest_symlink "$PROJECT_ID")
ARTIFACTS_DIR="${BUILD_DIR}/artifacts"
METADATA_FILE="${BUILD_DIR}/metadata.json"

info "Storing artifacts for $PROJECT_ID @ $COMMIT_SHA"
info "Source: $SOURCE_PATH"
info "Destination: $BUILD_DIR"

if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would store artifacts from $SOURCE_PATH to $ARTIFACTS_DIR"
    echo "[DRY RUN] Would create metadata: $METADATA_FILE"
    echo "[DRY RUN] Would update latest symlink: $LATEST_SYMLINK -> $BUILD_DIR"
    if [ "$DO_CLEANUP" = true ]; then
        echo "[DRY RUN] Would cleanup old builds (keep last $KEEP_LAST)"
    fi
    exit 0
fi

# Acquire lock for this project
if ! acquire_lock "$PROJECT_ID"; then
    error "Failed to acquire lock, aborting"
    exit 1
fi

# Setup trap to ensure lock is released
trap 'release_lock "$PROJECT_ID"' EXIT

# Create directories
ensure_dir "$ARTIFACTS_DIR"

# Store artifacts using hard links
info "Copying artifacts with hard links..."
if [ -d "$SOURCE_PATH" ]; then
    # For directories, use cp with hard links
    cp -al "$SOURCE_PATH/." "$ARTIFACTS_DIR/" 2>/dev/null || {
        # Fallback to regular copy if hard links fail
        info "Hard links failed, using regular copy"
        cp -r "$SOURCE_PATH/." "$ARTIFACTS_DIR/"
    }
else
    # For single files
    cp -l "$SOURCE_PATH" "$ARTIFACTS_DIR/" 2>/dev/null || {
        info "Hard link failed, using regular copy"
        cp "$SOURCE_PATH" "$ARTIFACTS_DIR/"
    }
fi

# Create metadata
info "Creating metadata..."
generate_metadata "$PROJECT_ID" "$COMMIT_SHA" "$SOURCE_PATH" > "$METADATA_FILE"

# Update latest symlink
info "Updating latest symlink..."
rm -f "$LATEST_SYMLINK"
ln -sfn "$BUILD_DIR" "$LATEST_SYMLINK"

# Cleanup old builds if requested
if [ "$DO_CLEANUP" = true ]; then
    info "Cleaning up old builds (keeping last $KEEP_LAST)..."
    cleanup_old_builds "$PROJECT_ID" "$KEEP_LAST"
fi

# Calculate and report statistics
ARTIFACT_SIZE=$(du -sb "$ARTIFACTS_DIR" 2>/dev/null | cut -f1 || echo 0)
ARTIFACT_COUNT=$(find "$ARTIFACTS_DIR" -type f 2>/dev/null | wc -l || echo 0)

info "Storage complete!"
info "  Artifacts: $ARTIFACT_COUNT files"
info "  Size: $(human_size $ARTIFACT_SIZE)"
 info "  Location: $BUILD_DIR"
 info "  Latest: $LATEST_SYMLINK"

 release_lock "$PROJECT_ID"
 trap - EXIT
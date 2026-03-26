#!/bin/bash
set -euo pipefail

# Fetch build artifacts from fleet cache using hard links
# Usage: fetch.sh <project-id> <target-path> [options]

source "$(dirname "$0")/common.sh"

# Parse arguments
if [ $# -lt 2 ]; then
    echo "Usage: $0 <project-id> <target-path> [options]"
    echo ""
    echo "Options:"
    echo "  --commit=<sha>     Fetch specific commit (default: latest)"
    echo "  --force            Overwrite existing files in target path"
    echo "  --verify-sha       Verify commit SHA matches current directory"
    echo "  --dry-run          Show what would be done without making changes"
    echo ""
    echo "Examples:"
    echo "  $0 bpf-project/bpf-application ./cached-build"
    echo "  $0 gymnerd-ar/gymnerd-bot ./dist --commit=abc123"
    exit 1
fi

PROJECT_ID="$1"
TARGET_PATH="$2"
shift 2

# Parse options
COMMIT_SHA="latest"
FORCE=false
VERIFY_SHA=false
DRY_RUN=false

while [ $# -gt 0 ]; do
    case "$1" in
        --commit=*)
            COMMIT_SHA="${1#*=}"
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --verify-sha)
            VERIFY_SHA=true
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

if [ -z "$TARGET_PATH" ]; then
    error "Target path cannot be empty"
    exit 1
fi

# Resolve commit SHA if "latest"
if [ "$COMMIT_SHA" = "latest" ]; then
    LATEST_SYMLINK=$(get_latest_symlink "$PROJECT_ID")
    if [ ! -L "$LATEST_SYMLINK" ]; then
        info "No cached build found for $PROJECT_ID"
        exit 1
    fi
    
    BUILD_DIR=$(readlink -f "$LATEST_SYMLINK")
    COMMIT_SHA=$(basename "$BUILD_DIR")
    info "Using latest build: $COMMIT_SHA"
else
    BUILD_DIR=$(get_build_cache_dir "$PROJECT_ID" "$COMMIT_SHA")
fi

# Check if build exists
if [ ! -d "$BUILD_DIR" ]; then
    info "No cached build found for $PROJECT_ID @ $COMMIT_SHA"
    exit 1
fi

ARTIFACTS_DIR="${BUILD_DIR}/artifacts"
METADATA_FILE="${BUILD_DIR}/metadata.json"

# Verify SHA if requested
if [ "$VERIFY_SHA" = true ]; then
    if [ -d ".git" ]; then
        CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
        if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$COMMIT_SHA" ]; then
            info "Warning: Current commit ($CURRENT_SHA) doesn't match cached commit ($COMMIT_SHA)"
            info "The cache may be outdated for this commit"
        fi
    fi
fi

# Check if target path exists
if [ -e "$TARGET_PATH" ] && [ "$FORCE" = false ]; then
    error "Target path already exists: $TARGET_PATH"
    error "Use --force to overwrite"
    exit 1
fi

info "Fetching artifacts for $PROJECT_ID @ $COMMIT_SHA"
info "Source: $ARTIFACTS_DIR"
info "Target: $TARGET_PATH"

if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] Would fetch artifacts from $ARTIFACTS_DIR to $TARGET_PATH"
    if [ -f "$METADATA_FILE" ]; then
        echo "[DRY RUN] Metadata:"
        cat "$METADATA_FILE" | jq . 2>/dev/null || cat "$METADATA_FILE"
    fi
    exit 0
fi

# Read metadata for information
if [ -f "$METADATA_FILE" ]; then
    CACHE_TIMESTAMP=$(jq -r '.timestamp' "$METADATA_FILE" 2>/dev/null || echo "unknown")
    CACHE_SIZE=$(jq -r '.artifacts.size_bytes' "$METADATA_FILE" 2>/dev/null || echo 0)
    info "Cache created: $CACHE_TIMESTAMP"
    info "Cache size: $(human_size $CACHE_SIZE)"
fi

# Remove existing target if force is enabled
if [ -e "$TARGET_PATH" ] && [ "$FORCE" = true ]; then
    info "Removing existing target: $TARGET_PATH"
    rm -rf "$TARGET_PATH"
fi

# Create target directory
mkdir -p "$(dirname "$TARGET_PATH")"

# Fetch artifacts using hard links
info "Copying artifacts with hard links..."
if [ -d "$ARTIFACTS_DIR" ]; then
    # Check if we can use hard links (same filesystem)
    ARTIFACTS_DEV=$(stat -c %d "$ARTIFACTS_DIR" 2>/dev/null || echo "")
    TARGET_PARENT_DEV=$(stat -c %d "$(dirname "$TARGET_PATH")" 2>/dev/null || echo "")
    
    if [ "$ARTIFACTS_DEV" = "$TARGET_PARENT_DEV" ] && [ -n "$ARTIFACTS_DEV" ]; then
        # Same filesystem, use hard links
        cp -al "$ARTIFACTS_DIR" "$TARGET_PATH" 2>/dev/null && {
            info "Used hard links (same filesystem)"
        } || {
            info "Hard links failed, using regular copy"
            cp -r "$ARTIFACTS_DIR" "$TARGET_PATH"
        }
    else
        # Different filesystem, use regular copy
        info "Different filesystem, using regular copy"
        cp -r "$ARTIFACTS_DIR" "$TARGET_PATH"
    fi
else
    error "Artifacts directory not found: $ARTIFACTS_DIR"
    exit 1
fi

# Verify the copy
if [ ! -e "$TARGET_PATH" ]; then
    error "Failed to copy artifacts to $TARGET_PATH"
    exit 1
fi

# Calculate statistics
FETCHED_SIZE=$(du -sb "$TARGET_PATH" 2>/dev/null | cut -f1 || echo 0)
FETCHED_COUNT=$(find "$TARGET_PATH" -type f 2>/dev/null | wc -l || echo 0)

info "Fetch complete!"
info "  Retrieved: $FETCHED_COUNT files"
info "  Size: $(human_size $FETCHED_SIZE)"
info "  Location: $TARGET_PATH"

# Check if hard links were used
if [ -e "$TARGET_PATH" ] && [ -e "$ARTIFACTS_DIR" ]; then
    SAMPLE_FILE=$(find "$TARGET_PATH" -type f 2>/dev/null | head -1)
    if [ -n "$SAMPLE_FILE" ]; then
        SAMPLE_INODE=$(stat -c %i "$SAMPLE_FILE" 2>/dev/null || echo "")
        ORIGINAL_FILE="${ARTIFACTS_DIR}${SAMPLE_FILE#$TARGET_PATH}"
        if [ -e "$ORIGINAL_FILE" ]; then
            ORIGINAL_INODE=$(stat -c %i "$ORIGINAL_FILE" 2>/dev/null || echo "")
            if [ "$SAMPLE_INODE" = "$ORIGINAL_INODE" ] && [ -n "$SAMPLE_INODE" ]; then
                info "  Hard links: YES (saving disk space)"
            else
                info "  Hard links: NO (full copy)"
            fi
        fi
    fi
fi

exit 0
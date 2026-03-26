#!/bin/bash
set -euo pipefail

# Show information about fleet cache
# Usage: info.sh [options]

source "$(dirname "$0")/common.sh"

list_project_dirs() {
    find "${FLEET_CACHE_DIR}/projects" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort
}

project_id_from_dir() {
    local project_dir="$1"
    local relative_path="${project_dir#${FLEET_CACHE_DIR}/projects/}"
    printf '%s\n' "$relative_path"
}

# Parse arguments
PROJECT_ID=""
SHOW_DETAILS=false

while [ $# -gt 0 ]; do
    case "$1" in
        --project=*)
            PROJECT_ID="${1#*=}"
            shift
            ;;
        --details)
            SHOW_DETAILS=true
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --project=ID      Show info for specific project"
            echo "  --details         Show detailed information"
            echo ""
            echo "Examples:"
            echo "  $0                    # Overall cache stats"
            echo "  $0 --project=owner/repo  # Project-specific stats"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Function to print section header
section() {
    echo ""
    echo "=== $1 ==="
    echo ""
}

# Function to print key-value pair
kv() {
    printf "  %-25s: %s\n" "$1" "$2"
}

# Check if cache directory exists
if [ ! -d "$FLEET_CACHE_DIR" ]; then
    error "Cache directory not found: $FLEET_CACHE_DIR"
    error "Make sure the volume is mounted correctly"
    exit 1
fi

if [ -n "$PROJECT_ID" ]; then
    # Show project-specific information
    validate_project_id "$PROJECT_ID"
    
    section "Project: $PROJECT_ID"
    
    PROJECT_DIR=$(get_project_cache_dir "$PROJECT_ID")
    BUILD_DIR="${PROJECT_DIR}/builds"
    LATEST_SYMLINK="${BUILD_DIR}/latest"
    
    if [ ! -d "$PROJECT_DIR" ]; then
        echo "  No cache data for this project"
        exit 0
    fi
    
    # Project statistics
    if [ -d "$BUILD_DIR" ]; then
        BUILD_COUNT=$(find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | wc -l)
        PROJECT_SIZE=$(du -sb "$PROJECT_DIR" 2>/dev/null | cut -f1 || echo 0)
        
        kv "Builds cached" "$BUILD_COUNT"
        kv "Total size" "$(human_size $PROJECT_SIZE)"
        
        if [ -L "$LATEST_SYMLINK" ]; then
            LATEST_BUILD=$(readlink -f "$LATEST_SYMLINK")
            LATEST_COMMIT=$(basename "$LATEST_BUILD")
            
            if [ -f "${LATEST_BUILD}/metadata.json" ]; then
                TIMESTAMP=$(jq -r '.timestamp' "${LATEST_BUILD}/metadata.json" 2>/dev/null || echo "unknown")
                SIZE=$(jq -r '.artifacts.size_bytes' "${LATEST_BUILD}/metadata.json" 2>/dev/null || echo 0)
                FILE_COUNT=$(jq -r '.artifacts.file_count' "${LATEST_BUILD}/metadata.json" 2>/dev/null || echo 0)
                
                kv "Latest commit" "$LATEST_COMMIT"
                kv "Latest cached" "$TIMESTAMP"
                kv "Latest size" "$(human_size $SIZE)"
                kv "Latest files" "$FILE_COUNT"
            fi
        fi
        
        if [ "$SHOW_DETAILS" = true ]; then
            echo ""
            echo "  Builds:"
            # List builds with details
            find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | while read -r build; do
                BUILD_NAME=$(basename "$build")
                if [ -f "${build}/metadata.json" ]; then
                    TIMESTAMP=$(jq -r '.timestamp' "${build}/metadata.json" 2>/dev/null || echo "unknown")
                    SIZE=$(jq -r '.artifacts.size_bytes' "${build}/metadata.json" 2>/dev/null || echo 0)
                    printf "    %-12s %-24s %10s\n" "$BUILD_NAME" "$TIMESTAMP" "$(human_size $SIZE)"
                else
                    printf "    %-12s %-24s\n" "$BUILD_NAME" "(no metadata)"
                fi
            done
        fi
    else
        echo "  No builds cached"
    fi
    
else
    # Show overall cache information
    section "Fleet Build Cache Overview"
    
    # Cache directory info
    CACHE_SIZE=$(du -sb "$FLEET_CACHE_DIR" 2>/dev/null | cut -f1 || echo 0)
    kv "Cache directory" "$FLEET_CACHE_DIR"
    kv "Total cache size" "$(echo "$CACHE_SIZE" | awk '{if ($1>=1073741824) printf "%.2f GB", $1/1073741824; else if ($1>=1048576) printf "%.2f MB", $1/1048576; else if ($1>=1024) printf "%.2f KB", $1/1024; else printf "%d B", $1}')"
    
    # Projects statistics
    PROJECTS_DIR="${FLEET_CACHE_DIR}/projects"
    if [ -d "$PROJECTS_DIR" ]; then
        PROJECT_COUNT=$(list_project_dirs | wc -l)
        kv "Projects cached" "$PROJECT_COUNT"
        
        # Total builds
        TOTAL_BUILDS=$(find "$PROJECTS_DIR" -type d -name "builds" -exec sh -c '
            count=0
            for builds_dir in "$@"; do
                builds=$(find "$builds_dir" -maxdepth 1 -mindepth 1 -type d ! -name latest | wc -l)
                count=$((count + builds))
            done
            echo "$count"
        ' sh {} + 2>/dev/null | tail -n 1)
        kv "Total builds" "$TOTAL_BUILDS"
        
        if [ "$SHOW_DETAILS" = true ] && [ "$PROJECT_COUNT" -gt 0 ]; then
            echo ""
            echo "  Projects:"
            # List projects with stats
            list_project_dirs | while read -r project; do
                PROJECT_NAME=$(project_id_from_dir "$project")
                if validate_project_id "$PROJECT_NAME" 2>/dev/null; then
                    BUILD_COUNT=$(find "$project/builds" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print 2>/dev/null | wc -l)
                    PROJECT_SIZE=$(du -sb "$project" 2>/dev/null | cut -f1 || echo 0)
                    printf "    %-30s %3d builds %10s\n" "$PROJECT_NAME" "$BUILD_COUNT" "$(human_size $PROJECT_SIZE)"
                fi
            done
        fi
    else
        kv "Projects cached" "0"
    fi
    
    # Disk usage warning
    echo ""
    if [ "$CACHE_SIZE" -gt $((50 * 1024 * 1024 * 1024)) ]; then  # 50GB
        echo "  ⚠️  Cache size is large (> 50GB)"
        echo "  Consider running: cleanup.sh --all-projects --keep-last=5"
    elif [ "$CACHE_SIZE" -gt $((10 * 1024 * 1024 * 1024)) ]; then  # 10GB
        echo "  ℹ️  Cache size is moderate"
    else
        echo "  ✅ Cache size is reasonable"
    fi
    
    # Check for lock files
    LOCKS_DIR="${FLEET_CACHE_DIR}/locks"
    if [ -d "$LOCKS_DIR" ]; then
        LOCK_COUNT=$(find "$LOCKS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
        if [ "$LOCK_COUNT" -gt 0 ]; then
            echo ""
            echo "  ⚠️  Found $LOCK_COUNT lock director$( [ "$LOCK_COUNT" -eq 1 ] && echo 'y' || echo 'ies' )"
            echo "  Some operations may be stuck or incomplete"
        fi
    fi
fi

echo ""
echo "For more details, use:"
echo "  info.sh --project=owner/repo --details"
echo "  cleanup.sh --all-projects --keep-last=10"
echo "  cleanup.sh --project=owner/repo --keep-last=5"

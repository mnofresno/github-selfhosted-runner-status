#!/bin/bash
set -euo pipefail

# Cleanup old builds in fleet cache
# Usage: cleanup.sh [options]

source "$(dirname "$0")/common.sh"

list_project_ids() {
    find "${FLEET_CACHE_DIR}/projects" -mindepth 2 -maxdepth 2 -type d 2>/dev/null \
        | sed "s#^${FLEET_CACHE_DIR}/projects/##" \
        | sort
}

# Parse arguments
KEEP_LAST=10
DRY_RUN=false
PROJECT_ID=""

while [ $# -gt 0 ]; do
    case "$1" in
        --keep-last=*)
            KEEP_LAST="${1#*=}"
            shift
            ;;
        --project=*)
            PROJECT_ID="${1#*=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --all-projects)
            # Clean all projects
            PROJECT_ID=""
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --keep-last=N     Keep last N builds per project (default: 10)"
            echo "  --project=ID      Clean specific project (e.g., owner/repo)"
            echo "  --all-projects    Clean all projects (default if --project not specified)"
            echo "  --dry-run         Show what would be deleted without making changes"
            echo ""
            echo "Examples:"
            echo "  $0 --all-projects --keep-last=5"
            echo "  $0 --project=bpf-project/bpf-application --keep-last=3"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# If no project specified, clean all projects
if [ -z "$PROJECT_ID" ]; then
    info "Cleaning all projects (keeping last $KEEP_LAST builds each)"
    
    # Find all project directories
    if [ ! -d "${FLEET_CACHE_DIR}/projects" ]; then
        info "No projects found in cache"
        exit 0
    fi
    
    # Get list of projects
    PROJECTS=$(list_project_ids)
    
    if [ -z "$PROJECTS" ]; then
        info "No projects found"
        exit 0
    fi
    
    TOTAL_DELETED=0
    TOTAL_SPACE=0
    
    for PROJ in $PROJECTS; do
        if validate_project_id "$PROJ" 2>/dev/null; then
            info "Processing project: $PROJ"
            
            if [ "$DRY_RUN" = true ]; then
                echo "[DRY RUN] Would cleanup project: $PROJ (keep last $KEEP_LAST)"
                continue
            fi
            
            # Acquire lock for this project
            if acquire_lock "$PROJ" 10; then
                # Count builds before cleanup
                BUILD_DIR="${FLEET_CACHE_DIR}/projects/${PROJ}/builds"
                if [ -d "$BUILD_DIR" ]; then
                    BEFORE_COUNT=$(find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | wc -l)
                    BEFORE_SIZE=$(du -sb "$BUILD_DIR" 2>/dev/null | cut -f1 || echo 0)
                    
                    # Perform cleanup
                    cleanup_old_builds "$PROJ" "$KEEP_LAST"
                    
                    # Count builds after cleanup
                    AFTER_COUNT=$(find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | wc -l)
                    AFTER_SIZE=$(du -sb "$BUILD_DIR" 2>/dev/null | cut -f1 || echo 0)
                    
                    DELETED=$((BEFORE_COUNT - AFTER_COUNT))
                    SPACE_SAVED=$((BEFORE_SIZE - AFTER_SIZE))
                    
                    if [ "$DELETED" -gt 0 ]; then
                        info "  Deleted $DELETED builds, saved $(human_size $SPACE_SAVED)"
                        TOTAL_DELETED=$((TOTAL_DELETED + DELETED))
                        TOTAL_SPACE=$((TOTAL_SPACE + SPACE_SAVED))
                    fi
                fi
                release_lock "$PROJ"
            else
                error "Failed to acquire lock for $PROJ, skipping"
            fi
        fi
    done
    
    if [ "$TOTAL_DELETED" -gt 0 ]; then
        info "Total: Deleted $TOTAL_DELETED builds, saved $(human_size $TOTAL_SPACE)"
    else
        info "No builds needed cleanup"
    fi
    
else
    # Clean specific project
    validate_project_id "$PROJECT_ID"
    
    info "Cleaning project: $PROJECT_ID (keeping last $KEEP_LAST builds)"
    
    if [ "$DRY_RUN" = true ]; then
        echo "[DRY RUN] Would cleanup project: $PROJECT_ID (keep last $KEEP_LAST)"
        echo "[DRY RUN] Would delete old builds beyond the last $KEEP_LAST"
        exit 0
    fi
    
    # Acquire lock for this project
    if ! acquire_lock "$PROJECT_ID"; then
        error "Failed to acquire lock for $PROJECT_ID"
        exit 1
    fi
    
    # Setup trap to ensure lock is released
    trap 'release_lock "$PROJECT_ID"' EXIT
    
    # Count builds before cleanup
    PROJECT_DIR=$(get_project_cache_dir "$PROJECT_ID")
    BUILD_DIR="${PROJECT_DIR}/builds"
    
    if [ ! -d "$BUILD_DIR" ]; then
        info "No builds found for project $PROJECT_ID"
        release_lock "$PROJECT_ID"
        trap - EXIT
        exit 0
    fi
    
    BEFORE_COUNT=$(find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | wc -l)
    BEFORE_SIZE=$(du -sb "$BUILD_DIR" 2>/dev/null | cut -f1 || echo 0)
    
    info "Before cleanup: $BEFORE_COUNT builds, $(human_size $BEFORE_SIZE)"
    
    # Perform cleanup
    cleanup_old_builds "$PROJECT_ID" "$KEEP_LAST"
    
    # Count builds after cleanup
    AFTER_COUNT=$(find "$BUILD_DIR" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print | wc -l)
    AFTER_SIZE=$(du -sb "$BUILD_DIR" 2>/dev/null | cut -f1 || echo 0)
    
    DELETED=$((BEFORE_COUNT - AFTER_COUNT))
    SPACE_SAVED=$((BEFORE_SIZE - AFTER_SIZE))
    
    info "After cleanup: $AFTER_COUNT builds, $(human_size $AFTER_SIZE)"
    
    if [ "$DELETED" -gt 0 ]; then
        info "Deleted $DELETED builds, saved $(human_size $SPACE_SAVED)"
    else
        info "No builds needed cleanup"
    fi
    
    release_lock "$PROJECT_ID"
    trap - EXIT
fi

info "Cleanup complete!"

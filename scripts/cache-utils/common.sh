#!/bin/bash
set -eu

# Common functions for fleet build cache system
# This script should be sourced by other cache scripts

# Default cache directory (mounted volume)
: "${FLEET_CACHE_DIR:=/cache}"

# Validate project ID format (owner/repo)
validate_project_id() {
    local project_id="$1"
    # POSIX-compliant regex check using expr
    if ! echo "$project_id" | grep -qE '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$'; then
        echo "ERROR: Invalid project ID format: '$project_id'" >&2
        echo "Expected format: owner/repo (e.g., bpf-project/bpf-application)" >&2
        return 1
    fi
    return 0
}

# Get project cache directory
get_project_cache_dir() {
    local project_id="$1"
    echo "${FLEET_CACHE_DIR}/projects/${project_id}"
}

# Get build cache directory for specific commit
get_build_cache_dir() {
    local project_id="$1"
    local commit_sha="$2"
    echo "$(get_project_cache_dir "$project_id")/builds/${commit_sha}"
}

# Get latest symlink path
get_latest_symlink() {
    local project_id="$1"
    echo "$(get_project_cache_dir "$project_id")/builds/latest"
}

# Create directory with proper permissions
ensure_dir() {
    local dir="$1"
    mkdir -p "$dir"
    # Ensure writable by all (since different users may access)
    chmod 0777 "$dir" 2>/dev/null || true
}

# Generate metadata JSON for a build
generate_metadata() {
    local project_id="$1"
    local commit_sha="$2"
    local source_path="$3"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Calculate size if path exists
    local size_bytes=0
    local file_count=0
    if [ -d "$source_path" ]; then
        size_bytes=$(du -sb "$source_path" | cut -f1)
        file_count=$(find "$source_path" -type f | wc -l)
    fi
    
    cat <<EOF
{
  "project": "$project_id",
  "commit": "$commit_sha",
  "timestamp": "$timestamp",
  "artifacts": {
    "size_bytes": $size_bytes,
    "file_count": $file_count,
    "source_path": "$source_path"
  },
  "build_context": {
    "hostname": "$(hostname)",
    "user": "$(whoami)"
  }
}
EOF
}

# Acquire lock for project operations
acquire_lock() {
    local project_id="$1"
    local lock_file="${FLEET_CACHE_DIR}/locks/${project_id//\//_}.lock"
    local timeout=${2:-30}  # Default 30 seconds
    
    ensure_dir "$(dirname "$lock_file")"
    
    # Simple lock implementation using mkdir (atomic)
    local start_time=$(date +%s)
    while [ $(($(date +%s) - start_time)) -lt "$timeout" ]; do
        # Try to create lock directory atomically
        if mkdir "$lock_file" 2>/dev/null; then
            echo "Lock acquired for $project_id"
            return 0
        fi
        
        # Check if lock is stale (older than 5 minutes)
        if [ -d "$lock_file" ]; then
            local lock_age=0
            if command -v stat >/dev/null 2>&1; then
                lock_age=$(($(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo 0)))
            else
                # Fallback using file modification time
                lock_age=$(($(date +%s) - $(date -r "$lock_file" +%s 2>/dev/null || echo 0)))
            fi
            if [ "$lock_age" -gt 300 ]; then  # 5 minutes
                echo "Removing stale lock for $project_id (age: ${lock_age}s)"
                rm -rf "$lock_file"
                continue
            fi
        fi
        
        sleep 1
    done
    
    echo "ERROR: Failed to acquire lock for $project_id after ${timeout}s" >&2
    return 1
}

# Release lock
release_lock() {
    local project_id="$1"
    local lock_file="${FLEET_CACHE_DIR}/locks/${project_id//\//_}.lock"
    rm -rf "$lock_file"
    echo "Lock released for $project_id"
}

# Cleanup old builds (keep last N)
cleanup_old_builds() {
    local project_id="$1"
    local keep_last="${2:-10}"  # Default keep last 10 builds
    
    local project_dir
    project_dir=$(get_project_cache_dir "$project_id")
    local builds_dir="${project_dir}/builds"
    
    if [ ! -d "$builds_dir" ]; then
        return 0
    fi
    
    # List builds by modification time, newest first
    local builds
    # Use portable method to get modification time
    builds=$(find "$builds_dir" -maxdepth 1 -mindepth 1 -type d -name "latest" -prune -o -type d -print -exec sh -c 'echo $(date -r "$1" +%s) "$1"' _ {} \; | sort -rn | cut -d' ' -f2-)
    
    local count=0
    
    echo "$builds" | while IFS= read -r build_dir; do
        if [ -z "$build_dir" ]; then
            continue
        fi
        
        count=$((count + 1))
        if [ $count -gt "$keep_last" ]; then
            echo "Deleting old build: $(basename "$build_dir")"
            rm -rf "$build_dir"
        fi
    done
}

# Log function with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# Error logging
error() {
    log "ERROR: $*" >&2
}

# Info logging
info() {
    log "INFO: $*"
}

# Human readable size
human_size() {
    local bytes="$1"
    awk -v bytes="$bytes" 'BEGIN {
        if (bytes >= 1073741824) printf "%.2f GB", bytes / 1073741824;
        else if (bytes >= 1048576) printf "%.2f MB", bytes / 1048576;
        else if (bytes >= 1024) printf "%.2f KB", bytes / 1024;
        else printf "%d B", bytes;
    }'
}

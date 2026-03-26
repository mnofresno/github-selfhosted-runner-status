#!/bin/bash
set -euo pipefail

# Setup script for mounting fleet cache volume on host
# This script should be run on the host machine (not in container)

echo "=== Fleet Build Cache Host Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (sudo)"
    exit 1
fi

# Create cache volume if it doesn't exist
echo "1. Creating Docker volume 'fleet-cache-global'..."
if ! docker volume inspect fleet-cache-global >/dev/null 2>&1; then
    docker volume create fleet-cache-global
    echo "   Volume created successfully"
else
    echo "   Volume already exists"
fi

# Create host link path
echo ""
echo "2. Creating host cache link..."
HOST_MOUNT_POINT="/var/cache/fleet"
mkdir -p "$(dirname "$HOST_MOUNT_POINT")"
VOLUME_PATH="/var/lib/docker/volumes/fleet-cache-global/_data"

# Check if already linked
if [ -L "$HOST_MOUNT_POINT" ] && [ "$(readlink "$HOST_MOUNT_POINT")" = "$VOLUME_PATH" ]; then
    echo "   Already linked: $HOST_MOUNT_POINT -> $VOLUME_PATH"
else
    if [ -d "$VOLUME_PATH" ]; then
        rm -rf "$HOST_MOUNT_POINT"
        ln -sfn "$VOLUME_PATH" "$HOST_MOUNT_POINT"
        echo "   Symlink created: $HOST_MOUNT_POINT -> $VOLUME_PATH"
    else
        echo "   Docker volume path not found: $VOLUME_PATH"
        exit 1
    fi
fi

# Create or refresh helper container used by tests and scripted copies
echo ""
echo "3. Ensuring helper container exists..."
docker rm -f fleet-cache-helper >/dev/null 2>&1 || true
docker run -d \
    --name fleet-cache-helper \
    -v fleet-cache-global:/cache:rw \
    --restart unless-stopped \
    ubuntu:24.04 tail -f /dev/null >/dev/null

docker exec fleet-cache-helper bash -lc 'apt-get update >/dev/null && apt-get install -y bash coreutils findutils grep sed gawk jq >/dev/null'

# Set permissions for git-autodeploy (www-data user)
echo ""
echo "4. Setting permissions..."
if id -u www-data >/dev/null 2>&1; then
    chown -R www-data:www-data "$HOST_MOUNT_POINT" 2>/dev/null || true
    chmod -R 0777 "$HOST_MOUNT_POINT" 2>/dev/null || true
    echo "   Permissions set for www-data user"
else
    echo "   www-data user not found, setting world-writable"
    chmod -R 0777 "$HOST_MOUNT_POINT" 2>/dev/null || true
fi

# Copy scripts to cache volume
echo ""
echo "5. Deploying cache scripts to volume..."
SCRIPTS_SOURCE="$(dirname "$0")/cache-utils"
if [ -d "$SCRIPTS_SOURCE" ]; then
    # Copy via helper container
    docker exec fleet-cache-helper mkdir -p /cache/scripts 2>/dev/null || true
    for script in "$SCRIPTS_SOURCE"/*.sh; do
        if [ -f "$script" ]; then
            script_name=$(basename "$script")
            docker cp "$script" fleet-cache-helper:/cache/scripts/"$script_name"
            docker exec fleet-cache-helper chmod +x /cache/scripts/"$script_name"
            echo "   Deployed: $script_name"
        fi
    done
    
    # Also copy common.sh
    if [ -f "$SCRIPTS_SOURCE/common.sh" ]; then
        docker cp "$SCRIPTS_SOURCE/common.sh" fleet-cache-helper:/cache/scripts/common.sh
        docker exec fleet-cache-helper chmod +x /cache/scripts/common.sh
        echo "   Deployed: common.sh"
    fi
    
    # Create initial directory structure
    docker exec fleet-cache-helper mkdir -p /cache/projects /cache/locks
    docker exec fleet-cache-helper chmod 0777 /cache/projects /cache/locks
else
    echo "   WARNING: Scripts source directory not found: $SCRIPTS_SOURCE"
fi

# Create convenience symlink in /usr/local/bin
echo ""
echo "6. Creating convenience symlinks..."
for cmd in store fetch cleanup info; do
    if [ ! -f "/usr/local/bin/fleet-cache-$cmd" ]; then
        ln -sf "$HOST_MOUNT_POINT/scripts/$cmd.sh" "/usr/local/bin/fleet-cache-$cmd" 2>/dev/null || true
    fi
done

# Test the setup
echo ""
echo "7. Testing setup..."
if [ -d "$HOST_MOUNT_POINT" ] && [ -d "$HOST_MOUNT_POINT/scripts" ]; then
    echo "   Host mount point: $HOST_MOUNT_POINT ✓"
    
    # Test script execution
    if [ -f "$HOST_MOUNT_POINT/scripts/info.sh" ]; then
        bash "$HOST_MOUNT_POINT/scripts/info.sh" --details 2>&1 | head -20
        echo "   Scripts are executable ✓"
    fi
else
    echo "   WARNING: Setup may be incomplete"
    echo "   Check that $HOST_MOUNT_POINT exists and contains scripts"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. To opt into runner cache mounts, set FLEET_CACHE_VOLUME=fleet-cache-global in .env"
echo "2. Restart github-runner-fleet: docker compose up -d --build"
echo "3. Test with: fleet-cache-info"
echo "4. Integrate with your project's CI/CD"
echo ""
echo "For git-autodeploy integration, use scripts from:"
echo "  $HOST_MOUNT_POINT/scripts/"
echo ""
echo "Example in .git-auto-deploy.yaml:"
echo "  post_fetch_commands:"
echo "    - if $HOST_MOUNT_POINT/scripts/fetch.sh \"owner/repo\" \"/tmp/cache-build\"; then"
echo "        echo \"Using cached build\";"
echo "        cp -r /tmp/cache-build/* ./dist/;"
echo "      else"
echo "        echo \"Building fresh\";"
echo "        npm run build;"
echo "      fi"

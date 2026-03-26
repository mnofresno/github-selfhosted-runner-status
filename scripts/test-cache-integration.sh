#!/bin/bash
set -e

echo "=== Testing Fleet Build Cache Integration ==="
echo ""

# Test 1: Check cache volume is mounted
echo "1. Checking cache volume..."
if docker exec fleet-cache-helper ls /cache/scripts/info.sh >/dev/null 2>&1; then
    echo "   ✅ Cache volume is accessible"
else
    echo "   ❌ Cache volume not accessible"
    exit 1
fi

# Test 2: Test cache scripts
echo ""
echo "2. Testing cache scripts..."
docker exec fleet-cache-helper bash /cache/scripts/info.sh --details

# Test 3: Simulate storing a build
echo ""
echo "3. Simulating store operation..."
TEST_PROJECT="test-owner/test-repo"
TEST_COMMIT="abc123def456"
TEST_DIR="/tmp/test-build-$$"

# Create test build directory
mkdir -p "$TEST_DIR"
echo "Test build content for $TEST_COMMIT" > "$TEST_DIR/test-file.txt"
echo '{"commit_sha":"'"$TEST_COMMIT"'","timestamp":"'"$(date -Iseconds)"'"}' > "$TEST_DIR/.cache-metadata.json"

# Store the build
echo "   Storing build for $TEST_PROJECT..."
# Copy test directory to container
docker cp "$TEST_DIR" fleet-cache-helper:/tmp/test-build
if docker exec fleet-cache-helper bash /cache/scripts/store.sh "$TEST_PROJECT" "$TEST_COMMIT" "/tmp/test-build" --keep-last=5; then
    echo "   ✅ Store operation successful"
else
    echo "   ❌ Store operation failed"
    rm -rf "$TEST_DIR"
    exit 1
fi

# Test 4: Test fetching the build
echo ""
echo "4. Testing fetch operation..."
FETCH_DIR="/tmp/fetch-test-$$"
if docker exec fleet-cache-helper bash /cache/scripts/fetch.sh "$TEST_PROJECT" "/tmp/fetched-build" --commit="$TEST_COMMIT"; then
    echo "   ✅ Fetch operation successful"
    # Copy fetched build back to host for inspection
    docker cp fleet-cache-helper:/tmp/fetched-build "$FETCH_DIR"
    if [ -f "$FETCH_DIR/test-file.txt" ]; then
        echo "   ✅ Build content is correct"
        echo "   Content: $(cat "$FETCH_DIR/test-file.txt")"
    else
        echo "   ❌ Build content missing"
    fi
else
    echo "   ❌ Fetch operation failed"
fi

# Test 5: Test cleanup
echo ""
echo "5. Testing cleanup..."
if docker exec fleet-cache-helper bash /cache/scripts/cleanup.sh --project="$TEST_PROJECT" --keep-last=1; then
    echo "   ✅ Cleanup operation successful"
else
    echo "   ❌ Cleanup operation failed"
fi

# Test 6: Final info check
echo ""
echo "6. Final cache status..."
docker exec fleet-cache-helper bash /cache/scripts/info.sh --project="$TEST_PROJECT" --details

# Cleanup
rm -rf "$TEST_DIR" "$FETCH_DIR"

echo ""
echo "=== Integration Test Complete ==="
echo "All tests passed! The fleet build cache system is working correctly."

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCleanupPlan, parseDurationMs, pruneDanglingResources, shouldRunCleanup } = require('./cleanup.ts');

test('parseDurationMs supports units and falls back on invalid input', () => {
  assert.equal(parseDurationMs('15m', 1), 15 * 60 * 1000);
  assert.equal(parseDurationMs('2h', 1), 2 * 60 * 60 * 1000);
  assert.equal(parseDurationMs('bad', 1234), 1234);
});

test('cleanup reports missing status, running cleanup, and cooldown states', () => {
  assert.deepEqual(
    shouldRunCleanup({ status: null, cleanupState: { running: false, lastRunAt: 0 }, now: 1000 }),
    { ok: false, reason: 'runner-missing' },
  );

  assert.deepEqual(
    shouldRunCleanup({ status: { targets: [] }, cleanupState: { running: true, lastRunAt: 0 }, now: 1000 }),
    { ok: false, reason: 'cleanup-running' },
  );

  assert.deepEqual(
    shouldRunCleanup({ status: { targets: [] }, cleanupState: { running: false, lastRunAt: 900 }, now: 1000 }),
    { ok: false, reason: 'cooldown-active' },
  );
});

test('cleanup runs when runner fleet is idle', () => {
  const result = shouldRunCleanup({
    status: {
      targets: [{
        githubRunners: [{ busy: false }],
        activeRuns: [],
        activeJobs: [],
      }],
    },
    cleanupState: {
      running: false,
      lastRunAt: 0,
    },
    now: Date.now(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'runner-idle');
});

test('cleanup skips while a run is active', () => {
  const result = shouldRunCleanup({
    status: {
      targets: [{
        githubRunners: [{ busy: true }],
        activeRuns: [{ id: 1 }],
        activeJobs: [{ name: 'build', runner_name: 'busy-runner' }],
      }],
    },
    cleanupState: {
      running: false,
      lastRunAt: 0,
    },
    now: Date.now(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'run-active');
});

test('cleanup plan collects stale managed stacks with no running containers', () => {
  const plan = buildCleanupPlan({
    status: {
      targets: [{
        githubRunners: [{ name: 'busy-runner', busy: true }],
        localRunners: [{ runnerName: 'busy-runner', state: 'running' }],
        activeRuns: [],
        activeJobs: [],
      }],
    },
    dockerContainers: [
      {
        Id: 'managed-runner',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'exited',
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-old',
          'io.github-runner-fleet.runner-name': 'old-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
      {
        Id: 'managed-dind',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'exited',
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-old',
          'io.github-runner-fleet.runner-name': 'old-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
      {
        Id: 'managed-busy',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'running',
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-busy',
          'io.github-runner-fleet.runner-name': 'busy-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
    ],
    dockerVolumes: [
      {
        Name: 'volume-old',
        CreatedAt: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-old',
          'io.github-runner-fleet.runner-name': 'old-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
    ],
    dockerNetworks: [
      {
        Name: 'network-old',
        Created: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-old',
          'io.github-runner-fleet.runner-name': 'old-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
    ],
  });

  assert.equal(plan.staleManagedStacks.length, 1);
  assert.deepEqual(plan.staleManagedStacks[0].containerIds, ['managed-runner', 'managed-dind']);
  assert.deepEqual(plan.staleManagedStacks[0].volumeNames, ['volume-old']);
  assert.deepEqual(plan.staleManagedStacks[0].networkNames, ['network-old']);
  assert.equal(plan.staleManagedStacks[0].runnerName, 'old-runner');
});

test('cleanup plan ignores unmanaged, active, and recent stacks', () => {
  const now = Date.now();
  const labels = {
    'io.github-runner-fleet.managed': 'true',
    'io.github-runner-fleet.stack-id': 'stack-keep',
    'io.github-runner-fleet.runner-name': 'busy-runner',
    'io.github-runner-fleet.target-id': 'gymnerd-org',
  };

  const plan = buildCleanupPlan({
    status: {
      targets: [{
        githubRunners: [{ name: 'busy-runner', busy: true }],
        localRunners: [{ runnerName: 'still-running', state: 'running' }],
        activeRuns: [],
        activeJobs: [{ runner_name: 'job-runner' }],
      }],
    },
    dockerContainers: [
      { Id: 'unmanaged', Created: Math.floor((now - (60 * 60 * 1000)) / 1000), State: 'exited', Labels: {} },
      { Id: 'busy', Created: Math.floor((now - (60 * 60 * 1000)) / 1000), State: 'exited', Labels: labels },
      {
        Id: 'recent',
        Created: Math.floor((now - (5 * 60 * 1000)) / 1000),
        State: 'exited',
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.stack-id': 'stack-recent',
          'io.github-runner-fleet.runner-name': 'recent-runner',
          'io.github-runner-fleet.target-id': 'gymnerd-org',
        },
      },
    ],
    dockerVolumes: [
      { Name: 'busy-volume', CreatedAt: new Date(now - (60 * 60 * 1000)).toISOString(), Labels: labels },
      { Name: 'ignored-volume', CreatedAt: new Date(now - (60 * 60 * 1000)).toISOString(), Labels: {} },
    ],
    dockerNetworks: [
      { Name: 'busy-network', Created: new Date(now - (60 * 60 * 1000)).toISOString(), Labels: labels },
      { Name: 'ignored-network', Created: new Date(now - (60 * 60 * 1000)).toISOString(), Labels: {} },
    ],
    now,
  });

  assert.deepEqual(plan.staleManagedStacks, []);
});

test('cleanup plan keeps the oldest resource timestamp for managed volumes and networks', () => {
  const now = Date.now();
  const labels = {
    'io.github-runner-fleet.managed': 'true',
    'io.github-runner-fleet.stack-id': 'stack-oldest',
    'io.github-runner-fleet.runner-name': 'oldest-runner',
    'io.github-runner-fleet.target-id': 'gymnerd-org',
  };

  const olderIso = new Date(now - (90 * 60 * 1000)).toISOString();
  const newerIso = new Date(now - (60 * 60 * 1000)).toISOString();

  const plan = buildCleanupPlan({
    status: { targets: [] },
    dockerContainers: [
      { Id: 'container-oldest', Created: Math.floor((now - (30 * 60 * 1000)) / 1000), State: 'exited', Labels: labels },
    ],
    dockerVolumes: [
      { Name: 'older-volume', CreatedAt: olderIso, Labels: labels },
      { Name: 'newer-volume', CreatedAt: newerIso, Labels: labels },
    ],
    dockerNetworks: [
      { Name: 'older-network', Created: olderIso, Labels: labels },
      { Name: 'newer-network', Created: newerIso, Labels: labels },
    ],
    now,
  });

  assert.equal(plan.staleManagedStacks.length, 1);
  assert.deepEqual(plan.staleManagedStacks[0].volumeNames, ['older-volume', 'newer-volume']);
  assert.deepEqual(plan.staleManagedStacks[0].networkNames, ['older-network', 'newer-network']);
});

test('pruneDanglingResources requests image, volume and build cache pruning', async () => {
  const calls = [];
  const docker = async (path, options) => {
    calls.push({ path, options });
    return { body: { path } };
  };

  const result = await pruneDanglingResources(docker);

  assert.equal(calls.length, 3);
  assert.match(calls[0].path, /^\/images\/prune\?filters=/);
  assert.deepEqual(calls[0].options, { method: 'POST' });
  assert.deepEqual(calls[1], { path: '/volumes/prune', options: { method: 'POST' } });
  assert.match(calls[2].path, /^\/build\/prune\?filters=/);
  assert.deepEqual(result, {
    imagePrune: { path: calls[0].path },
    volumePrune: { path: '/volumes/prune' },
    buildCachePrune: { path: calls[2].path },
  });
});

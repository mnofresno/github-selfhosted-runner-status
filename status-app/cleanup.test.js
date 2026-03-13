const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCleanupPlan, shouldRunCleanup } = require('./cleanup');

test('cleanup runs when runner is idle', () => {
  const result = shouldRunCleanup({
    status: {
      targets: [{
        githubRunners: [{ busy: false }],
        activeRun: null,
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

test('cleanup skips while runner is busy', () => {
  const result = shouldRunCleanup({
    status: {
      targets: [{
        githubRunners: [{ busy: true }],
        activeRun: { id: 1 },
        activeJobs: [{ name: 'build' }],
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

test('cleanup plan collects stale exited runners and orphan compose projects', () => {
  const plan = buildCleanupPlan({
    status: {
      targets: [{
        githubRunners: [{ name: 'busy-runner', busy: true }],
        localRunners: [{ runnerName: 'busy-runner', state: 'running' }],
        activeRun: null,
        activeJobs: [],
      }],
    },
    dockerContainers: [
      {
        Id: 'managed-exited',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'exited',
        Labels: {
          'io.github-runner-fleet.managed': 'true',
          'io.github-runner-fleet.runner-name': 'old-runner',
        },
      },
      {
        Id: 'compose-nginx',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'running',
        Labels: {
          'com.docker.compose.project': 'orphan-runner-123',
          'com.docker.compose.project.working_dir': '/tmp/github-runner/orphan-runner-123/repo',
          'com.docker.compose.network': 'orphan-runner-123_default',
        },
      },
      {
        Id: 'compose-ignored',
        Created: Math.floor((Date.now() - (45 * 60 * 1000)) / 1000),
        State: 'running',
        Labels: {
          'com.docker.compose.project': 'busy-runner',
          'com.docker.compose.project.working_dir': '/tmp/github-runner/busy-runner/repo',
        },
      },
    ],
  });

  assert.deepEqual(plan.staleManagedRunnerIds, ['managed-exited']);
  assert.equal(plan.staleComposeProjects.length, 1);
  assert.equal(plan.staleComposeProjects[0].project, 'orphan-runner-123');
  assert.equal(plan.staleComposeProjects[0].workdir, '/tmp/github-runner/orphan-runner-123');
  assert.deepEqual(plan.staleComposeProjects[0].containerIds, ['compose-nginx']);
});

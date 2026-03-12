const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunCleanup } = require('./cleanup');

test('cleanup runs when runner is idle', () => {
  const result = shouldRunCleanup({
    status: {
      runner: { busy: false },
      activeRun: null,
      activeJobs: [],
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
      runner: { busy: true },
      activeRun: { id: 1 },
      activeJobs: [{ name: 'build' }],
    },
    cleanupState: {
      running: false,
      lastRunAt: 0,
    },
    now: Date.now(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runner-busy');
});

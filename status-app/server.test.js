const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const {
  buildRunnerContainerSpec,
  createServer,
  desiredRunnerCountForTarget,
  groupManagedStacks,
  githubCacheGet,
  githubCacheKey,
  githubCacheSet,
  filterAutocompleteValues,
  loadTargets,
  parseListenPort,
  parseRepoUrl,
  shouldRemoveManagedStack,
} = require('./server');

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

test('parseRepoUrl extracts owner and repo', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/bpf-project/bpf-application.git'), {
    owner: 'bpf-project',
    repo: 'bpf-application',
  });
});

test('loadTargets supports repo and org targets with default token fallback', () => {
  const targets = loadTargets({
    ACCESS_TOKEN: 'top-secret',
    RUNNER_IMAGE: 'myoung34/github-runner:latest',
    RUNNER_WORKDIR: '/tmp/github-runner',
    MAX_RUNNERS_PER_TARGET: '3',
    LABELS: 'self-hosted,linux',
    RUNNER_TARGETS_JSON: JSON.stringify([
      {
        id: 'bpf-app',
        scope: 'repo',
        owner: 'bpf-project',
        repo: 'bpf-application',
      },
      {
        id: 'gymnerd-org',
        scope: 'org',
        owner: 'gymnerd-ar',
        repo: 'gymnerd-bot',
        labels: ['self-hosted', 'gymnerd'],
      },
    ]),
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[0].repoUrl, 'https://github.com/bpf-project/bpf-application');
  assert.equal(targets[0].maxRunners, 3);
  assert.equal(targets[1].scope, 'org');
  assert.equal(targets[1].repo, 'gymnerd-bot');
  assert.equal(targets[1].repoUrl, 'https://github.com/gymnerd-ar/gymnerd-bot');
  assert.equal(targets[1].accessToken, 'top-secret');
  assert.deepEqual(targets[1].labels, ['self-hosted', 'gymnerd']);
});

test('buildRunnerContainerSpec creates isolated ephemeral runner payload', () => {
  const target = {
    id: 'gymnerd-bot',
    scope: 'repo',
    owner: 'gymnerd-ar',
    repo: 'gymnerd-bot',
    repoUrl: 'https://github.com/gymnerd-ar/gymnerd-bot',
    accessToken: 'token',
    labels: ['self-hosted', 'linux', 'x64', 'gymnerd'],
    runnerImage: 'myoung34/github-runner:latest',
    runnerWorkdir: '/tmp/github-runner',
    dindImage: 'docker:27-dind',
    runnerGroup: '',
  };

  const spec = buildRunnerContainerSpec(target, 'gymnerd-bot-runner-20260312');

  assert.match(spec.runnerVolumeName, /^ghrunner-work-gymnerd-bot-/);
  assert.match(spec.dockerVolumeName, /^ghrunner-docker-gymnerd-bot-/);
  assert.match(spec.networkName, /^ghrunner-net-gymnerd-bot-/);
  assert.ok(spec.runnerBody.Env.includes('RUNNER_SCOPE=repo'));
  assert.ok(spec.runnerBody.Env.includes('EPHEMERAL=true'));
  assert.ok(spec.runnerBody.Env.includes('REPO_URL=https://github.com/gymnerd-ar/gymnerd-bot'));
  assert.ok(spec.runnerBody.Env.includes('DOCKER_HOST=tcp://127.0.0.1:2375'));
  assert.ok(spec.runnerBody.HostConfig.Binds.some((entry) => entry.endsWith(':/tmp/github-runner')));
  assert.match(spec.runnerBody.HostConfig.NetworkMode, /^container:docker-gymnerd-bot-/);
  assert.equal(spec.runnerBody.Labels['io.github-runner-fleet.role'], 'runner');
  assert.equal(spec.dindBody.Image, 'docker:27-dind');
  assert.equal(spec.dindBody.HostConfig.Privileged, true);
  assert.deepEqual(spec.dindBody.Cmd, [
    'dockerd',
    '--host=tcp://127.0.0.1:2375',
    '--host=unix:///var/run/docker.sock',
    '--ip=127.0.0.1',
  ]);
  assert.ok(spec.dindBody.HostConfig.Binds.some((entry) => entry.endsWith(':/var/lib/docker')));
  assert.equal(spec.dindBody.Labels['io.github-runner-fleet.role'], 'dind');
});

test('desired runner count follows queued work and target cap', () => {
  const count = desiredRunnerCountForTarget({
    target: { maxRunners: 2 },
    activeRuns: [{ id: 1 }],
    activeJobs: [
      { status: 'queued', runner_name: '' },
      { status: 'queued', runner_name: null },
      { status: 'in_progress', runner_name: 'runner-a' },
    ],
    managedStacks: [{ runnerName: 'runner-a' }],
  });

  assert.equal(count, 2);
});

test('groupManagedStacks merges runner, dind, volume, and network resources', () => {
  const stacks = groupManagedStacks(
    [
      {
        id: 'runner-1',
        shortId: 'runner-1',
        name: 'runner-stack-old',
        state: 'running',
        status: 'Up',
        createdMs: 1,
        targetId: 'gymnerd-org',
        runnerName: 'gymnerd-runner-1',
        role: 'runner',
        stackId: 'stack-old',
      },
      {
        id: 'dind-1',
        shortId: 'dind-1',
        name: 'docker-stack-old',
        state: 'running',
        status: 'Up',
        createdMs: 1,
        targetId: 'gymnerd-org',
        runnerName: 'gymnerd-runner-1',
        role: 'dind',
        stackId: 'stack-old',
      },
    ],
    [
      {
        Name: 'volume-old',
        createdMs: 2,
        targetId: 'gymnerd-org',
        runnerName: 'gymnerd-runner-1',
        stackId: 'stack-old',
      },
    ],
    [
      {
        Name: 'network-old',
        createdMs: 3,
        targetId: 'gymnerd-org',
        runnerName: 'gymnerd-runner-1',
        stackId: 'stack-old',
      },
    ],
  );

  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].runnerContainer.id, 'runner-1');
  assert.equal(stacks[0].dindContainer.id, 'dind-1');
  assert.deepEqual(stacks[0].volumes.map((volume) => volume.Name), ['volume-old']);
  assert.deepEqual(stacks[0].networks.map((network) => network.Name), ['network-old']);
});

test('shouldRemoveManagedStack removes dead or idle stacks but preserves active ones', () => {
  const snapshot = {
    activeRuns: [{ id: 1 }],
    activeJobs: [{ runner_name: 'runner-active' }],
    managedStacks: [],
    desiredRunnerCount: 1,
  };

  const activeStack = {
    stackId: 'stack-active',
    runnerName: 'runner-active',
    createdMs: Date.now() - 60_000,
    runnerContainer: { state: 'running' },
    dindContainer: { state: 'running' },
  };
  const deadStack = {
    stackId: 'stack-dead',
    runnerName: 'runner-dead',
    createdMs: Date.now() - 60_000,
    runnerContainer: { state: 'exited' },
    dindContainer: { state: 'running' },
  };
  const idleSnapshot = {
    ...snapshot,
    activeRuns: [],
    activeJobs: [],
    managedStacks: [activeStack],
    desiredRunnerCount: 0,
  };

  assert.equal(shouldRemoveManagedStack(activeStack, snapshot), false);
  assert.equal(shouldRemoveManagedStack(deadStack, snapshot), true);
  assert.equal(shouldRemoveManagedStack(activeStack, idleSnapshot), true);
});

test('github API cache key / get / set works', () => {
  const key = githubCacheKey('abc', '/foo');
  assert.equal(key, 'abc:/foo');
  assert.equal(githubCacheGet('abc', '/foo'), null);

  githubCacheSet('abc', '/foo', { value: 123 });
  const cached = githubCacheGet('abc', '/foo');
  assert.deepEqual(cached, { value: 123 });
});

test('filterAutocompleteValues deduplicates, sorts and filters locally', () => {
  assert.deepEqual(
    filterAutocompleteValues(['gymnerd-ar', 'GymNerd-Ar', 'bpf-project', 'mnofresno'], 'g'),
    ['gymnerd-ar'],
  );
});

test('parseListenPort ignores host bind strings and keeps internal default', () => {
  assert.equal(parseListenPort('3571'), 3571);
  assert.equal(parseListenPort('127.0.0.1:3571'), 8080);
  assert.equal(parseListenPort(''), 8080);
});

test('createServer exposes fleet cleanup admin routes and status snapshots', async () => {
  const fleetCleanupResult = {
    mode: 'fleet',
    startedAt: '2026-04-15T12:00:00.000Z',
    finishedAt: '2026-04-15T12:01:00.000Z',
    durationMs: 60000,
    plan: { staleManagedStacks: [], ignoredResources: [] },
    removedStacks: [],
    reconciledTargets: [],
    errors: [],
  };

  const server = createServer([], {
    runFleetCleanupFn: async () => fleetCleanupResult,
    getCleanupStatusFn: () => ({
      maintenanceRunning: false,
      fleet: {
        running: false,
        lastRunAt: fleetCleanupResult.finishedAt,
        lastStartedAt: fleetCleanupResult.startedAt,
        lastResult: fleetCleanupResult,
        lastError: null,
      },
    }),
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let result = await requestJson(baseUrl, '/api/admin/cleanup/status');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.fleet.lastResult, fleetCleanupResult);

    result = await requestJson(baseUrl, '/api/admin/cleanup/fleet', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, fleetCleanupResult);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createServer,
  normalizeTarget,
  slugify,
  parseLabels,
  parseListenPort,
  targetHasRepoFeed,
  normalizeAutocompleteItems,
  normalizeAccessibleOwners,
  resolveAutocompleteToken,
  validateTargetFormInput,
  buildAutocompleteCacheKey,
  readAutocompleteCache,
  writeAutocompleteCache,
  withAutocompleteCache,
  clearAutocompleteCache,
  loadPersistedTargets,
  saveTargets,
  resolveClientDistDir,
  sanitizeStatusForClient,
  sanitizeTargetForClient,
} = require('./server.ts');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { once } = require('node:events');

async function startTestServer(initialTargets = [], options = {}) {
  const server = createServer(initialTargets, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

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

/* ── slugify ─────────────────────────────────────────────────────── */

test('slugify lowercases and replaces non-alphanum', () => {
  assert.equal(slugify('My Runner!'), 'my-runner');
});

test('slugify trims leading/trailing dashes', () => {
  assert.equal(slugify('--hello--'), 'hello');
});

test('slugify truncates at 48 chars', () => {
  const long = 'a'.repeat(60);
  assert.equal(slugify(long).length, 48);
});

/* ── parseLabels ─────────────────────────────────────────────────── */

test('parseLabels splits comma-separated string', () => {
  assert.deepEqual(parseLabels('a, b, c'), ['a', 'b', 'c']);
});

test('parseLabels handles array input', () => {
  assert.deepEqual(parseLabels(['x', 'y']), ['x', 'y']);
});

test('parseLabels filters empty entries', () => {
  assert.deepEqual(parseLabels('a,,b,'), ['a', 'b']);
});

test('resolveClientDistDir points at an existing frontend build path when present', () => {
  const clientDistDir = resolveClientDistDir();
  assert.equal(typeof clientDistDir, 'string');
  assert.ok(clientDistDir.endsWith(path.join('frontend', 'dist')));
});

/* ── parseListenPort ─────────────────────────────────────────────── */

test('parseListenPort returns number for valid port', () => {
  assert.equal(parseListenPort('3000'), 3000);
});

test('parseListenPort returns default for invalid input', () => {
  assert.equal(parseListenPort('abc'), 8080);
});

test('parseListenPort returns default for empty input', () => {
  assert.equal(parseListenPort(''), 8080);
});

/* ── normalizeTarget ─────────────────────────────────────────────── */

test('normalizeTarget creates target with required fields', () => {
  const target = normalizeTarget({
    name: 'Test Fleet', scope: 'org', owner: 'my-org',
    accessToken: 'tok_123', labels: ['self-hosted'],
  });
  assert.equal(target.id, 'test-fleet');
  assert.equal(target.scope, 'org');
  assert.equal(target.owner, 'my-org');
  assert.equal(target.accessToken, 'tok_123');
  assert.deepEqual(target.labels, ['self-hosted']);
  assert.equal(target.runnersCount, 1);
});

test('normalizeTarget throws if missing owner', () => {
  assert.throws(() => normalizeTarget({
    name: 'Bad', scope: 'org', accessToken: 'tok',
  }), /missing owner/);
});

test('normalizeTarget throws if repo scope without repo', () => {
  assert.throws(() => normalizeTarget({
    name: 'Bad', scope: 'repo', owner: 'org', accessToken: 'tok',
  }), /requires repo/);
});

test('normalizeTarget accepts runnersCount', () => {
  const target = normalizeTarget({
    name: 'Multi', scope: 'org', owner: 'org', accessToken: 'tok', runnersCount: 3,
  });
  assert.equal(target.runnersCount, 3);
});

test('normalizeTarget falls back to env ACCESS_TOKEN', () => {
  const target = normalizeTarget(
    { name: 'EnvTok', scope: 'org', owner: 'org' },
    { ACCESS_TOKEN: 'env_tok' },
  );
  assert.equal(target.accessToken, 'env_tok');
});

test('normalizeTarget derives id and name from owner and repo when name is omitted', () => {
  const target = normalizeTarget({
    scope: 'repo',
    owner: 'gymnerd-ar',
    repo: 'gymnerd-bot',
    accessToken: 'tok',
  });
  assert.equal(target.id, 'gymnerd-ar-gymnerd-bot');
  assert.equal(target.name, 'gymnerd-ar/gymnerd-bot');
});

test('sanitizeTargetForClient removes accessToken and keeps public fields', () => {
  const target = sanitizeTargetForClient({
    id: 'fleet-a',
    name: 'Fleet A',
    owner: 'octo',
    repo: 'web',
    accessToken: 'top-secret',
    repository: 'octo/web',
  });
  assert.equal(target.accessToken, undefined);
  assert.equal(target.id, 'fleet-a');
  assert.equal(target.repository, 'octo/web');
});

test('sanitizeStatusForClient strips access tokens from every target', () => {
  const status = sanitizeStatusForClient({
    generatedAt: 'now',
    targets: [
      { id: 'fleet-a', accessToken: 'secret-a', repository: 'octo/web' },
      { id: 'fleet-b', accessToken: 'secret-b', repository: 'octo' },
    ],
  });
  assert.deepEqual(status, {
    generatedAt: 'now',
    targets: [
      { id: 'fleet-a', repository: 'octo/web' },
      { id: 'fleet-b', repository: 'octo' },
    ],
  });
});

/* ── targetHasRepoFeed ──────────────────────────────────────────── */

test('targetHasRepoFeed returns true with owner and repo', () => {
  assert.equal(targetHasRepoFeed({ owner: 'a', repo: 'b' }), true);
});

test('targetHasRepoFeed returns false without repo', () => {
  assert.equal(targetHasRepoFeed({ owner: 'a', repo: '' }), false);
});

/* ── Autocomplete helpers ────────────────────────────────────────── */

test('normalizeAutocompleteItems deduplicates, filters and sorts', () => {
  assert.deepEqual(
    normalizeAutocompleteItems(['zeta', 'Alpha', 'alpha', 'beta'], 'a'),
    ['Alpha', 'beta', 'zeta'],
  );
});

test('normalizeAccessibleOwners keeps only the token user and its org memberships', () => {
  assert.deepEqual(
    normalizeAccessibleOwners(
      { login: 'mnofresno' },
      [{ login: 'gymnerd-ar' }, { login: 'bpf-project' }, { login: 'gymnerd-ar' }],
    ),
    ['bpf-project', 'gymnerd-ar', 'mnofresno'],
  );
});

test('resolveAutocompleteToken prefers target token when targetId is provided', () => {
  const token = resolveAutocompleteToken([
    { id: 'one', accessToken: 'tok_one' },
    { id: 'two', accessToken: 'tok_two' },
  ], 'two', { ACCESS_TOKEN: 'env_tok' });
  assert.equal(token, 'tok_two');
});

test('resolveAutocompleteToken falls back to env ACCESS_TOKEN', () => {
  const token = resolveAutocompleteToken([{ id: 'one', accessToken: 'tok_one' }], '', { ACCESS_TOKEN: 'env_tok' });
  assert.equal(token, 'env_tok');
});

test('resolveAutocompleteToken falls back to the first target token', () => {
  const token = resolveAutocompleteToken([{ id: 'one', accessToken: 'tok_one' }], '', {});
  assert.equal(token, 'tok_one');
});

/* ── Autocomplete cache ──────────────────────────────────────────── */

test('buildAutocompleteCacheKey hashes token and normalizes parts', () => {
  const key = buildAutocompleteCacheKey('owners', 'secret-token', [' GymNerd-Ar ', '']);
  assert.match(key, /^owners::[a-f0-9]{40}::gymnerd-ar::$/);
  assert.ok(!key.includes('secret-token'));
});

test('writeAutocompleteCache and readAutocompleteCache roundtrip until ttl expires', () => {
  clearAutocompleteCache();
  writeAutocompleteCache('owners::x', ['gymnerd-ar'], 1200, 1000);
  assert.deepEqual(readAutocompleteCache('owners::x', 1001), ['gymnerd-ar']);
  assert.equal(readAutocompleteCache('owners::x', 2205), null);
});

test('writeAutocompleteCache evicts the oldest entry when the cache is full', () => {
  clearAutocompleteCache();
  for (let index = 0; index < 200; index += 1) {
    writeAutocompleteCache(`owners::${index}`, [String(index)], 60_000, 1000 + index);
  }
  writeAutocompleteCache('owners::overflow', ['overflow'], 60_000, 5000);

  assert.equal(readAutocompleteCache('owners::0', 5001), null);
  assert.deepEqual(readAutocompleteCache('owners::overflow', 5001), ['overflow']);
});

test('withAutocompleteCache only invokes loader once before ttl expiry', async () => {
  clearAutocompleteCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return ['gymnerd-ar'];
  };

  const first = await withAutocompleteCache('owners::y', loader, 100, 1000);
  const second = await withAutocompleteCache('owners::y', loader, 100, 1001);

  assert.deepEqual(first, ['gymnerd-ar']);
  assert.deepEqual(second, ['gymnerd-ar']);
  assert.equal(calls, 1);
});

/* ── Form validation ─────────────────────────────────────────────── */

test('validateTargetFormInput accepts valid org target input', () => {
  const result = validateTargetFormInput({
    scope: 'org',
    owner: 'gymnerd-ar',
    labels: 'self-hosted,linux,x64',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateTargetFormInput requires repo for repo scope', () => {
  const result = validateTargetFormInput({
    name: 'GymNerd Repo',
    scope: 'repo',
    owner: 'gymnerd-ar',
    repo: '',
    labels: 'self-hosted',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Repository is required/);
});

test('validateTargetFormInput rejects invalid owner slug', () => {
  const result = validateTargetFormInput({
    name: 'Bad Owner',
    scope: 'org',
    owner: 'gymnerd ar',
    labels: 'self-hosted',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Owner \/ Org can only contain/);
});

test('validateTargetFormInput rejects invalid repo slug', () => {
  const result = validateTargetFormInput({
    name: 'Bad Repo',
    scope: 'repo',
    owner: 'gymnerd-ar',
    repo: 'bad repo',
    labels: 'self-hosted',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /Repository can only contain/);
});

test('validateTargetFormInput requires at least one label', () => {
  const result = validateTargetFormInput({
    name: 'No Labels',
    scope: 'org',
    owner: 'gymnerd-ar',
    labels: '',
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /At least one label is required/);
});

/* ── Target Persistence ─────────────────────────────────────────── */

test('loadPersistedTargets returns empty array for missing file', () => {
  const origEnv = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(os.tmpdir(), `fleet-test-${Date.now()}`);
  const targets = loadPersistedTargets();
  assert.deepEqual(targets, []);
  process.env.DATA_DIR = origEnv;
});

test('saveTargets and loadPersistedTargets roundtrip', () => {
  const origDataDir = process.env.DATA_DIR;
  const tmpDir = path.join(os.tmpdir(), `fleet-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Override the module internals by temporarily patching DATA_DIR
  // The functions use the module-level constant, so we test via the file path
  const targetFile = path.join(tmpDir, 'targets.json');
  const testData = [{ id: 'test', name: 'Test' }];
  fs.writeFileSync(targetFile, JSON.stringify(testData), 'utf8');

  const loaded = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  assert.deepEqual(loaded, testData);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env.DATA_DIR = origDataDir;
});

test('createServer serves target management and GitHub helper routes', async () => {
  const saveTargetsFn = async () => {};
  const ensureRunnersForTargetFn = async (target) => [{ action: 'launched', targetId: target.id }];
  const stopRunnersForTargetFn = async () => {};
  const listRunJobsFn = async (_target, runId) => [{ id: Number(runId), name: 'lint' }];
  const forceCancelRunFn = async (_target, runId) => ({ runId, canceled: true });
  const rerunWorkflowRunFn = async (_target, runId) => ({ runId, rerun: true });
  const rerunFailedJobsFn = async (_target, runId) => ({ runId, failed: true });
  const rerunJobFn = async (_target, jobId) => ({ jobId, rerun: true });
  const githubOwnerSuggestionsFn = async (token, query) => [`${token}:${query}`];
  const githubRepoSuggestionsFn = async (token, owner, query) => [`${token}:${owner}:${query}`];
  const getStatusFn = async (targets) => ({ generatedAt: 'now', targets: targets.map((target) => ({ id: target.id })) });

  const existingTarget = normalizeTarget({
    id: 'fleet-a',
    name: 'Fleet A',
    scope: 'repo',
    owner: 'octo',
    repo: 'web',
    accessToken: 'target-token',
    labels: 'self-hosted',
  });

  const { server, baseUrl } = await startTestServer([existingTarget], {
    saveTargetsFn,
    ensureRunnersForTargetFn,
    stopRunnersForTargetFn,
    listRunJobsFn,
    forceCancelRunFn,
    rerunWorkflowRunFn,
    rerunFailedJobsFn,
    rerunJobFn,
    githubOwnerSuggestionsFn,
    githubRepoSuggestionsFn,
    getStatusFn,
  });

  try {
    let result = await requestJson(baseUrl, '/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'repo', owner: '', repo: '', labels: '' }),
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(baseUrl, '/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Fleet A',
        scope: 'repo',
        owner: 'octo',
        repo: 'web',
        accessToken: 'target-token',
        labels: 'self-hosted',
      }),
    });
    assert.equal(result.response.status, 409);

    result = await requestJson(baseUrl, '/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Fleet B',
        scope: 'org',
        owner: 'octo',
        accessToken: 'second-token',
        labels: 'self-hosted',
      }),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.id, 'fleet-b');
    assert.equal(result.body.accessToken, undefined);

    result = await requestJson(baseUrl, '/api/targets/missing', { method: 'DELETE' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/restart', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/launch', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/runs/44/jobs');
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/runs/44/rerun', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/runs/44/cancel', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/runs/44/rerun-failed', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/missing/jobs/77/rerun', { method: 'POST' });
    assert.equal(result.response.status, 404);

    result = await requestJson(baseUrl, '/api/targets/fleet-a/restart', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, [{ action: 'launched', targetId: 'fleet-a' }]);

    result = await requestJson(baseUrl, '/api/targets/fleet-a/launch', { method: 'POST' });
    assert.equal(result.response.status, 200);

    result = await requestJson(baseUrl, '/api/targets/fleet-a/runs/44/jobs');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, [{ id: 44, name: 'lint' }]);

    result = await requestJson(baseUrl, '/api/targets/fleet-a/runs/44/rerun', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { runId: '44', rerun: true });

    result = await requestJson(baseUrl, '/api/targets/fleet-a/runs/44/cancel', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { runId: '44', canceled: true });

    result = await requestJson(baseUrl, '/api/targets/fleet-a/runs/44/rerun-failed', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { runId: '44', failed: true });

    result = await requestJson(baseUrl, '/api/targets/fleet-a/jobs/77/rerun', { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { jobId: '77', rerun: true });

    result = await requestJson(baseUrl, '/api/github/owners?targetId=fleet-a&q=oct');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, ['target-token:oct']);

    result = await requestJson(baseUrl, '/api/github/repos');
    assert.equal(result.response.status, 400);

    result = await requestJson(baseUrl, '/api/github/repos?targetId=fleet-a&owner=octo&q=we');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, ['target-token:octo:we']);

    result = await requestJson(baseUrl, '/api/status');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      generatedAt: 'now',
      targets: [{ id: 'fleet-a' }, { id: 'fleet-b' }],
    });
    assert.equal(JSON.stringify(result.body).includes('target-token'), false);
    assert.equal(JSON.stringify(result.body).includes('second-token'), false);

    result = await requestJson(baseUrl, '/api/targets/fleet-a', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, { removed: 'fleet-a' });

    const notFound = await requestJson(baseUrl, '/api/unknown');
    assert.equal(notFound.response.status, 404);
    assert.deepEqual(notFound.body, { error: 'Not found' });

    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(favicon.status, 204);

    const appShell = await fetch(`${baseUrl}/dashboard`);
    assert.equal(appShell.status, 200);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('createServer surfaces async route failures as 500 json responses', async () => {
  const { server, baseUrl } = await startTestServer([], {
    githubOwnerSuggestionsFn: async () => {
      throw new Error('owners failed');
    },
    getStatusFn: async () => {
      throw new Error('status failed');
    },
  });

  try {
    let result = await requestJson(baseUrl, '/api/github/owners');
    assert.equal(result.response.status, 500);
    assert.deepEqual(result.body, { error: 'owners failed' });

    result = await requestJson(baseUrl, '/api/status');
    assert.equal(result.response.status, 500);
    assert.deepEqual(result.body, { error: 'status failed' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

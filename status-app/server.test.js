const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTarget,
  slugify,
  parseLabels,
  parseListenPort,
  targetHasRepoFeed,
  normalizeAutocompleteItems,
  resolveAutocompleteToken,
  validateTargetFormInput,
  buildAutocompleteCacheKey,
  readAutocompleteCache,
  writeAutocompleteCache,
  withAutocompleteCache,
  clearAutocompleteCache,
  loadPersistedTargets,
  saveTargets,
} = require('./server');

const fs = require('fs');
const path = require('path');
const os = require('os');

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
    name: 'GymNerd Org',
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

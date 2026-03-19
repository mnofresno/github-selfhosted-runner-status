const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_PORT = 8080;
const DEFAULT_WORKDIR = '/tmp/github-runner';
const DEFAULT_DIND_IMAGE = 'docker:27-dind';
const DEFAULT_RUNNERS_PER_TARGET = Math.max(1, Number.parseInt(process.env.RUNNERS_PER_TARGET || '1', 10));
const DEFAULT_RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'myoung34/github-runner:latest';
const HEALTHCHECK_INTERVAL_MS = Number.parseInt(process.env.HEALTHCHECK_INTERVAL_MS || '15000', 10);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');
const AUTOCOMPLETE_CACHE_TTL_MS = Number.parseInt(process.env.AUTOCOMPLETE_CACHE_TTL_MS || '60000', 10);
const AUTOCOMPLETE_CACHE_MAX_ENTRIES = Math.max(20, Number.parseInt(process.env.AUTOCOMPLETE_CACHE_MAX_ENTRIES || '200', 10));

const MANAGED_LABEL = 'io.github-runner-fleet.managed';
const MANAGED_TARGET_LABEL = 'io.github-runner-fleet.target-id';
const MANAGED_RUNNER_LABEL = 'io.github-runner-fleet.runner-name';
const MANAGED_ROLE_LABEL = 'io.github-runner-fleet.role';
const MANAGED_STACK_LABEL = 'io.github-runner-fleet.stack-id';
const CLIENT_DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');

/* ── Utilities ──────────────────────────────────────────────────────── */

function collectJson(res, resolve, reject) {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const body = data ? JSON.parse(data) : {};
      resolve({ statusCode: res.statusCode, body });
    } catch (error) {
      reject(error);
    }
  });
  res.on('error', reject);
}

function collectText(res, resolve, reject) {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
  res.on('error', reject);
}

function httpRequest(handler, options, body) {
  return new Promise((resolve, reject) => {
    const req = handler.request(options, (r) => collectJson(r, resolve, reject));
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

function httpRequestText(handler, options) {
  return new Promise((resolve, reject) => {
    const req = handler.request(options, (r) => collectText(r, resolve, reject));
    req.on('error', reject);
    req.end();
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value) {
  return String(value || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseLabels(value) {
  if (Array.isArray(value)) return value.map((i) => String(i).trim()).filter(Boolean);
  return String(value || '').split(',').map((i) => i.trim()).filter(Boolean);
}

function parseListenPort(value) {
  const c = String(value || '').trim();
  return /^\d+$/.test(c) ? Number.parseInt(c, 10) : DEFAULT_PORT;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ── Small In-Memory Cache ─────────────────────────────────────────── */

const autocompleteCache = new Map();

function hashToken(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function buildAutocompleteCacheKey(scope, token, parts = []) {
  return [scope, hashToken(token), ...parts.map((part) => String(part || '').trim().toLowerCase())].join('::');
}

function readAutocompleteCache(key, now = Date.now()) {
  const entry = autocompleteCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    autocompleteCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeAutocompleteCache(key, value, ttlMs = AUTOCOMPLETE_CACHE_TTL_MS, now = Date.now()) {
  if (autocompleteCache.size >= AUTOCOMPLETE_CACHE_MAX_ENTRIES) {
    const oldestKey = autocompleteCache.keys().next().value;
    if (oldestKey) autocompleteCache.delete(oldestKey);
  }
  autocompleteCache.set(key, {
    value,
    expiresAt: now + Math.max(1000, ttlMs),
  });
  return value;
}

function clearAutocompleteCache() {
  autocompleteCache.clear();
}

async function withAutocompleteCache(key, loader, ttlMs = AUTOCOMPLETE_CACHE_TTL_MS, now = Date.now()) {
  const cached = readAutocompleteCache(key, now);
  if (cached) return cached;
  const value = await loader();
  return writeAutocompleteCache(key, value, ttlMs, now);
}

/* ── GitHub API ─────────────────────────────────────────────────────── */

function githubRequest(token, ghPath, { method = 'GET' } = {}) {
  return httpRequest(https, {
    hostname: 'api.github.com',
    path: ghPath,
    method,
    headers: {
      'User-Agent': 'runner-fleet',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

async function github(token, ghPath, options) {
  const response = await githubRequest(token, ghPath, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`GitHub API ${response.statusCode}: ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  return response.body;
}

/* ── Docker API ─────────────────────────────────────────────────────── */

function docker(dPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock', path: dPath, method, headers,
    }, (r) => collectJson(r, resolve, reject));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function dockerText(dPath) {
  return httpRequestText(http, {
    socketPath: '/var/run/docker.sock', path: dPath, method: 'GET',
  });
}

async function createContainer(name, body) {
  const response = await docker(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Container create ${name} failed: ${response.statusCode} ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  return response.body.Id;
}

async function startContainer(containerId) {
  const response = await docker(`/containers/${containerId}/start`, { method: 'POST' });
  if (![204, 304].includes(response.statusCode)) {
    throw new Error(`Container start failed: ${response.statusCode}`);
  }
}

async function removeContainerForce(containerId) {
  const response = await docker(`/containers/${containerId}?force=1`, { method: 'DELETE' });
  if (![204, 404].includes(response.statusCode)) {
    throw new Error(`Container delete failed: ${response.statusCode}`);
  }
}

async function createVolume(name, labels = {}) {
  const response = await docker('/volumes/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Name: name, Labels: { [MANAGED_LABEL]: 'true', ...labels } }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Volume create failed: ${response.statusCode}`);
  }
}

async function removeVolume(name) {
  const response = await docker(`/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (![204, 404].includes(response.statusCode)) {
    throw new Error(`Volume delete failed: ${response.statusCode}`);
  }
}

async function createNetwork(name, labels = {}) {
  const response = await docker('/networks/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Name: name, Driver: 'bridge', Labels: { [MANAGED_LABEL]: 'true', ...labels } }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Network create failed: ${response.statusCode}`);
  }
}

async function removeNetwork(name) {
  const response = await docker(`/networks/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (![204, 404].includes(response.statusCode)) {
    throw new Error(`Network delete failed: ${response.statusCode}`);
  }
}

async function waitForDockerDaemon(containerId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await dockerText(`/containers/${containerId}/logs?stdout=1&stderr=1&tail=100`);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const logs = response.body || '';
      if (logs.includes('API listen on') || logs.includes('Daemon has completed initialization')) return;
    }
    await sleep(500);
  }
  throw new Error(`Docker daemon did not become ready in container ${containerId.slice(0, 12)}`);
}

async function listAllContainers() {
  const response = await docker('/containers/json?all=1');
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Docker API ${response.statusCode}`);
  return response.body;
}

async function listManagedContainers() {
  const all = await listAllContainers();
  return all.filter((c) => c.Labels?.[MANAGED_LABEL] === 'true');
}

async function inspectContainer(containerId) {
  const response = await docker(`/containers/${containerId}/json`);
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Inspect failed: ${response.statusCode}`);
  return response.body;
}

/* ── Target Persistence ──────────────────────────────────────────────── */

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
}

function loadPersistedTargets() {
  try {
    const raw = fs.readFileSync(TARGETS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTargets(targets) {
  ensureDataDir();
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2), 'utf8');
}

function normalizeTarget(input, env = process.env) {
  const scope = String(input.scope || 'org').toLowerCase();
  const id = slugify(input.id || input.name || `target-${Date.now()}`);
  const owner = input.owner || input.org || '';
  const repo = input.repo || '';
  const token = input.accessToken || env.ACCESS_TOKEN || '';
  const labels = parseLabels(input.labels || env.LABELS || 'self-hosted,linux,x64');
  const runnersCount = Math.max(1, Number.parseInt(input.runnersCount || input.runners || DEFAULT_RUNNERS_PER_TARGET, 10) || 1);
  const image = input.runnerImage || env.RUNNER_IMAGE || DEFAULT_RUNNER_IMAGE;
  const workdir = input.runnerWorkdir || env.RUNNER_WORKDIR || DEFAULT_WORKDIR;
  const dindImage = input.dindImage || env.DIND_IMAGE || DEFAULT_DIND_IMAGE;

  if (!token) throw new Error(`Target "${id}" is missing accessToken`);
  if (!owner) throw new Error(`Target "${id}" is missing owner`);
  if (scope === 'repo' && !repo) throw new Error(`Target "${id}" requires repo for repo scope`);

  return {
    id, name: input.name || id, scope, owner, repo, accessToken: token,
    labels, runnersCount, runnerImage: image, runnerWorkdir: workdir,
    dindImage, runnerGroup: input.runnerGroup || '',
    description: input.description || '',
  };
}

function loadTargets(env = process.env) {
  const persisted = loadPersistedTargets();
  if (persisted.length) return persisted.map((t) => normalizeTarget(t, env));

  if (env.RUNNER_TARGETS_JSON) {
    const configured = JSON.parse(env.RUNNER_TARGETS_JSON);
    if (Array.isArray(configured) && configured.length) {
      const targets = configured.map((t) => normalizeTarget(t, env));
      saveTargets(targets);
      return targets;
    }
  }

  if (env.ACCESS_TOKEN && env.ORG_NAME) {
    const targets = [normalizeTarget({
      id: 'default', name: 'Default', scope: env.RUNNER_SCOPE || 'org',
      owner: env.ORG_NAME, repo: env.REPO_NAME || '',
      accessToken: env.ACCESS_TOKEN, labels: env.LABELS,
    }, env)];
    saveTargets(targets);
    return targets;
  }

  return [];
}

function targetHasRepoFeed(target) {
  return Boolean(target.owner && target.repo);
}

function normalizeAutocompleteItems(items, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const seen = new Set();
  return items
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return !needle || key.includes(needle);
    })
    .sort((a, b) => a.localeCompare(b));
}

function resolveAutocompleteToken(targets, requestedTargetId, env = process.env) {
  if (requestedTargetId) {
    const matched = targets.find((target) => target.id === requestedTargetId);
    if (matched?.accessToken) return matched.accessToken;
  }
  if (env.ACCESS_TOKEN) return env.ACCESS_TOKEN;
  return targets.find((target) => target.accessToken)?.accessToken || '';
}

function validateTargetFormInput(input) {
  const scope = String(input.scope || 'org').toLowerCase();
  const owner = String(input.owner || '').trim();
  const repo = String(input.repo || '').trim();
  const name = String(input.name || '').trim();
  const labels = parseLabels(input.labels || '');
  const errors = [];
  const slugPattern = /^[A-Za-z0-9_.-]+$/;

  if (!name) errors.push('Name is required.');
  if (!owner) {
    errors.push('Owner / Org is required.');
  } else if (!slugPattern.test(owner)) {
    errors.push('Owner / Org can only contain letters, numbers, ".", "_" and "-".');
  }

  if (scope === 'repo' && !repo) {
    errors.push('Repository is required when scope is repository.');
  } else if (repo && !slugPattern.test(repo)) {
    errors.push('Repository can only contain letters, numbers, ".", "_" and "-".');
  }

  if (!labels.length) {
    errors.push('At least one label is required.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

async function githubOwnerSuggestions(token, q = '') {
  const query = String(q || '').trim();
  if (!token) throw new Error('Missing ACCESS_TOKEN for owner lookup');
  const cacheKey = buildAutocompleteCacheKey('owners', token, [query]);

  return withAutocompleteCache(cacheKey, async () => {
    if (query) {
      const payload = await github(token, `/search/users?q=${encodeURIComponent(`${query} in:login`)}&per_page=20`);
      return normalizeAutocompleteItems((payload.items || []).map((item) => item.login), query);
    }

    const [user, orgs] = await Promise.all([
      github(token, '/user'),
      github(token, '/user/orgs?per_page=100'),
    ]);

    return normalizeAutocompleteItems([
      user?.login,
      ...(Array.isArray(orgs) ? orgs.map((org) => org.login) : []),
    ]);
  });
}

async function githubRepoSuggestions(token, owner, q = '') {
  const query = String(q || '').trim();
  const ownerName = String(owner || '').trim();
  if (!token) throw new Error('Missing ACCESS_TOKEN for repo lookup');
  if (!ownerName) throw new Error('Owner / Org is required for repo lookup');
  const cacheKey = buildAutocompleteCacheKey('repos', token, [ownerName, query]);

  return withAutocompleteCache(cacheKey, async () => {
    if (query) {
      const payload = await github(token, `/search/repositories?q=${encodeURIComponent(`${query} user:${ownerName}`)}&per_page=50`);
      return normalizeAutocompleteItems((payload.items || []).map((item) => item.name), query);
    }

    try {
      const orgRepos = await github(token, `/orgs/${encodeURIComponent(ownerName)}/repos?per_page=100`);
      return normalizeAutocompleteItems((Array.isArray(orgRepos) ? orgRepos : []).map((repo) => repo.name));
    } catch (error) {
      if (!error.message.includes('404')) throw error;
    }

    const userRepos = await github(token, `/users/${encodeURIComponent(ownerName)}/repos?per_page=100`);
    return normalizeAutocompleteItems((Array.isArray(userRepos) ? userRepos : []).map((repo) => repo.name));
  });
}

/* ── Persistent Runner Management ────────────────────────────────────── */

function runnerContainerName(targetId, index) {
  return `fleet-runner-${targetId}-${index}`.slice(0, 63);
}

function dindContainerName(targetId, index) {
  return `fleet-dind-${targetId}-${index}`.slice(0, 63);
}

function networkName(targetId, index) {
  return `fleet-net-${targetId}-${index}`.slice(0, 63);
}

function workVolumeName(targetId, index) {
  return `fleet-work-${targetId}-${index}`;
}

function dockerVolumeName(targetId, index) {
  return `fleet-docker-${targetId}-${index}`;
}

function stackId(targetId, index) {
  return `${targetId}-${index}`;
}

function buildLabels(target, runnerName, role, sId) {
  return {
    [MANAGED_LABEL]: 'true',
    [MANAGED_TARGET_LABEL]: target.id,
    [MANAGED_RUNNER_LABEL]: runnerName,
    [MANAGED_ROLE_LABEL]: role,
    [MANAGED_STACK_LABEL]: sId,
  };
}

async function launchRunnerStack(target, index) {
  const rName = runnerContainerName(target.id, index);
  const dName = dindContainerName(target.id, index);
  const nName = networkName(target.id, index);
  const wName = workVolumeName(target.id, index);
  const dvName = dockerVolumeName(target.id, index);
  const sId = stackId(target.id, index);
  const labels = [...target.labels, `target:${target.id}`, `scope:${target.scope}`].filter(Boolean);

  const runnerEnv = [
    `ACCESS_TOKEN=${target.accessToken}`,
    `RUNNER_SCOPE=${target.scope}`,
    `RUNNER_NAME=${rName}`,
    `RUNNER_WORKDIR=${target.runnerWorkdir}`,
    `LABELS=${labels.join(',')}`,
    'EPHEMERAL=false',
    'DISABLE_AUTO_UPDATE=true',
    'RANDOM_RUNNER_SUFFIX=false',
    'DOCKER_HOST=tcp://127.0.0.1:2375',
  ];

  if (target.scope === 'repo') {
    runnerEnv.push(`REPO_URL=https://github.com/${target.owner}/${target.repo}`);
  } else {
    runnerEnv.push(`ORG_NAME=${target.owner}`);
  }
  if (target.runnerGroup) runnerEnv.push(`RUNNER_GROUP=${target.runnerGroup}`);

  try {
    await createNetwork(nName, buildLabels(target, rName, 'network', sId));
    await createVolume(wName, buildLabels(target, rName, 'volume', sId));
    await createVolume(dvName, buildLabels(target, rName, 'volume', sId));

    const dindId = await createContainer(dName, {
      Image: target.dindImage,
      Env: ['DOCKER_TLS_CERTDIR='],
      Cmd: ['dockerd', '--host=tcp://127.0.0.1:2375', '--host=unix:///var/run/docker.sock', '--ip=127.0.0.1'],
      Hostname: 'docker',
      Labels: buildLabels(target, rName, 'dind', sId),
      HostConfig: {
        Privileged: true,
        NetworkMode: nName,
        Binds: [`${dvName}:/var/lib/docker`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      NetworkingConfig: { EndpointsConfig: { [nName]: {} } },
    });
    await startContainer(dindId);
    await waitForDockerDaemon(dindId);

    const runnerId = await createContainer(rName, {
      Image: target.runnerImage,
      Env: runnerEnv,
      Labels: buildLabels(target, rName, 'runner', sId),
      HostConfig: {
        NetworkMode: `container:${dName}`,
        Binds: [`${wName}:${target.runnerWorkdir}`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await startContainer(runnerId);

    return { targetId: target.id, runnerName: rName, containerId: runnerId, stackId: sId };
  } catch (error) {
    await removeStack(sId).catch(() => {});
    throw error;
  }
}

async function removeStack(sId) {
  const containers = await listManagedContainers();
  const matching = containers.filter((c) => c.Labels?.[MANAGED_STACK_LABEL] === sId);
  for (const c of matching) {
    await removeContainerForce(c.Id).catch(() => {});
  }

  const volResponse = await docker(`/volumes?filters=${encodeURIComponent(JSON.stringify({ label: [`${MANAGED_STACK_LABEL}=${sId}`] }))}`);
  for (const v of (volResponse.body?.Volumes || [])) {
    await removeVolume(v.Name).catch(() => {});
  }

  const netResponse = await docker(`/networks?filters=${encodeURIComponent(JSON.stringify({ label: [`${MANAGED_STACK_LABEL}=${sId}`] }))}`);
  for (const n of (netResponse.body || [])) {
    await removeNetwork(n.Name).catch(() => {});
  }
}

async function getRunnerContainerState(targetId, index) {
  const name = runnerContainerName(targetId, index);
  const all = await listAllContainers();
  const match = all.find((c) => (c.Names || []).some((n) => n === `/${name}` || n === name));
  if (!match) return null;
  return {
    id: match.Id,
    name,
    state: match.State,
    status: match.Status,
    image: match.Image,
    created: match.Created,
  };
}

async function ensureRunnersForTarget(target) {
  const results = [];
  for (let i = 0; i < target.runnersCount; i++) {
    const state = await getRunnerContainerState(target.id, i);
    if (state && state.state === 'running') {
      results.push({ ...state, action: 'already-running' });
      continue;
    }
    if (state) {
      await removeStack(stackId(target.id, i)).catch(() => {});
    }
    try {
      const launched = await launchRunnerStack(target, i);
      results.push({ ...launched, action: 'launched' });
    } catch (error) {
      results.push({ targetId: target.id, index: i, action: 'error', error: error.message });
    }
  }
  return results;
}

async function ensureAllRunners(targets) {
  const all = [];
  for (const target of targets) {
    const r = await ensureRunnersForTarget(target);
    all.push(...r);
  }
  return all;
}

async function stopRunnersForTarget(targetId, runnersCount) {
  for (let i = 0; i < runnersCount; i++) {
    await removeStack(stackId(targetId, i)).catch(() => {});
  }
}

/* ── GitHub Data Fetching (for dashboard) ────────────────────────────── */

async function githubRunnersForTarget(target) {
  try {
    if (target.scope === 'repo') {
      const payload = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runners`);
      return payload.runners || [];
    }
    const payload = await github(target.accessToken, `/orgs/${target.owner}/actions/runners`);
    return payload.runners || [];
  } catch {
    return [];
  }
}

async function latestRunsForTarget(target) {
  if (!targetHasRepoFeed(target)) return [];
  try {
    const payload = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs?per_page=8`);
    return (payload.workflow_runs || []).map((run) => ({
      id: run.id, name: run.name, event: run.event, status: run.status,
      conclusion: run.conclusion, url: run.html_url, created_at: run.created_at,
    }));
  } catch {
    return [];
  }
}

async function listRunJobs(target, runId) {
  if (!targetHasRepoFeed(target)) return [];
  const jobs = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/jobs`);
  return (jobs.jobs || []).map((job) => ({
    id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
    started_at: job.started_at, completed_at: job.completed_at,
    runner_name: job.runner_name, html_url: job.html_url,
  }));
}

async function rerunWorkflowRun(target, runId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) throw new Error(`Rerun failed: ${response.statusCode}`);
  return { runId, statusCode: response.statusCode };
}

async function rerunFailedJobs(target, runId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) throw new Error(`Rerun failed jobs failed: ${response.statusCode}`);
  return { runId, statusCode: response.statusCode };
}

async function rerunJob(target, jobId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/jobs/${jobId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) throw new Error(`Rerun job failed: ${response.statusCode}`);
  return { jobId, statusCode: response.statusCode };
}

/* ── Status Snapshot ─────────────────────────────────────────────────── */

async function getTargetSnapshot(target) {
  const [ghRunners, latestRuns] = await Promise.all([
    githubRunnersForTarget(target),
    latestRunsForTarget(target),
  ]);

  const localRunners = [];
  for (let i = 0; i < target.runnersCount; i++) {
    const s = await getRunnerContainerState(target.id, i);
    localRunners.push(s || { name: runnerContainerName(target.id, i), state: 'not-created', status: 'absent' });
  }

  const activeRuns = latestRuns.filter((r) => r.status !== 'completed');

  return {
    ...target,
    repository: targetHasRepoFeed(target) ? `${target.owner}/${target.repo}` : target.owner,
    localRunners,
    githubRunners: ghRunners.map((r) => ({
      id: r.id, name: r.name, status: r.status, busy: r.busy,
      labels: (r.labels || []).map((l) => l.name), os: r.os,
    })),
    latestRuns, activeRuns,
  };
}

async function getStatus(targets) {
  const snapshots = await Promise.all(targets.map(getTargetSnapshot));
  return { generatedAt: new Date().toISOString(), targets: snapshots };
}

/* ── HTTP Server ─────────────────────────────────────────────────────── */

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] || 'application/octet-stream';
}

function safeClientPathname(urlPathname) {
  const normalized = path.normalize(urlPathname).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized === path.sep ? '' : normalized.replace(/^[/\\]+/, '');
}

function sendFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mimeTypeFor(filePath),
    'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

function sendClientApp(res) {
  sendFile(res, path.join(CLIENT_DIST_DIR, 'index.html'));
}

function trySendClientAsset(res, urlPathname) {
  const assetPath = path.join(CLIENT_DIST_DIR, safeClientPathname(urlPathname));
  if (!assetPath.startsWith(CLIENT_DIST_DIR)) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    sendFile(res, assetPath);
    return true;
  }

  return false;
}

function createServer(initialTargets, _options = {}) {
  let targets = [...initialTargets];

  function resolveTarget(id) {
    return targets.find((t) => t.id === id);
  }

  return http.createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      const url = new URL(req.url, 'http://localhost');

      /* ── CRUD for targets ── */
      if (url.pathname === '/api/targets' && req.method === 'POST') {
        const input = JSON.parse(body);
        const validation = validateTargetFormInput(input);
        if (!validation.valid) {
          sendJson(res, 400, { error: validation.errors.join(' ') });
          return;
        }
        input.accessToken = input.accessToken || process.env.ACCESS_TOKEN;
        const target = normalizeTarget(input);
        if (targets.find((t) => t.id === target.id)) {
          sendJson(res, 409, { error: `Target "${target.id}" already exists` }); return;
        }
        targets.push(target);
        saveTargets(targets);
        ensureRunnersForTarget(target).catch((e) => console.error('[fleet] launch error:', e.message));
        sendJson(res, 201, target);
        return;
      }

      const targetIdMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
      if (targetIdMatch && req.method === 'DELETE') {
        const target = resolveTarget(targetIdMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        await stopRunnersForTarget(target.id, target.runnersCount);
        targets = targets.filter((t) => t.id !== target.id);
        saveTargets(targets);
        sendJson(res, 200, { removed: target.id });
        return;
      }

      const restartMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/restart$/);
      if (restartMatch && req.method === 'POST') {
        const target = resolveTarget(restartMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        await stopRunnersForTarget(target.id, target.runnersCount);
        const results = await ensureRunnersForTarget(target);
        sendJson(res, 200, results);
        return;
      }

      const launchMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/launch$/);
      if (launchMatch && req.method === 'POST') {
        const target = resolveTarget(launchMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        const results = await ensureRunnersForTarget(target);
        sendJson(res, 200, results);
        return;
      }

      /* ── Run controls ── */
      const runJobsMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/jobs$/);
      if (runJobsMatch && req.method === 'GET') {
        const target = resolveTarget(runJobsMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, await listRunJobs(target, runJobsMatch[2]));
        return;
      }

      const rerunRunMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/rerun$/);
      if (rerunRunMatch && req.method === 'POST') {
        const target = resolveTarget(rerunRunMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, await rerunWorkflowRun(target, rerunRunMatch[2]));
        return;
      }

      const rerunFailedMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/rerun-failed$/);
      if (rerunFailedMatch && req.method === 'POST') {
        const target = resolveTarget(rerunFailedMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, await rerunFailedJobs(target, rerunFailedMatch[2]));
        return;
      }

      const rerunJobMatch = url.pathname.match(/^\/api\/targets\/([^/]+)\/jobs\/(\d+)\/rerun$/);
      if (rerunJobMatch && req.method === 'POST') {
        const target = resolveTarget(rerunJobMatch[1]);
        if (!target) { sendJson(res, 404, { error: 'Not found' }); return; }
        sendJson(res, 200, await rerunJob(target, rerunJobMatch[2]));
        return;
      }

      if (url.pathname === '/api/github/owners' && req.method === 'GET') {
        const token = resolveAutocompleteToken(targets, url.searchParams.get('targetId'));
        const owners = await githubOwnerSuggestions(token, url.searchParams.get('q'));
        sendJson(res, 200, owners);
        return;
      }

      if (url.pathname === '/api/github/repos' && req.method === 'GET') {
        const owner = String(url.searchParams.get('owner') || '').trim();
        if (!owner) {
          sendJson(res, 400, { error: 'Owner / Org is required.' });
          return;
        }
        const token = resolveAutocompleteToken(targets, url.searchParams.get('targetId'));
        const repos = await githubRepoSuggestions(token, owner, url.searchParams.get('q'));
        sendJson(res, 200, repos);
        return;
      }

      /* ── Dashboard / Status ── */
      if (url.pathname === '/api/status') {
        sendJson(res, 200, await getStatus(targets));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      if (url.pathname !== '/' && trySendClientAsset(res, url.pathname)) {
        return;
      }

      sendClientApp(res);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

/* ── Healthcheck Loop (restart crashed runners only) ─────────────── */

function startHealthcheck(targets) {
  return setInterval(async () => {
    try {
      for (const target of targets) {
        await ensureRunnersForTarget(target);
      }
    } catch (error) {
      console.error('[fleet] healthcheck error:', error.message);
    }
  }, HEALTHCHECK_INTERVAL_MS);
}

/* ── Entry Point ─────────────────────────────────────────────────── */

if (require.main === module) {
  const targets = loadTargets();
  console.log(`[fleet] loaded ${targets.length} target(s)`);

  ensureAllRunners(targets)
    .then((results) => {
      const launched = results.filter((r) => r.action === 'launched').length;
      const running = results.filter((r) => r.action === 'already-running').length;
      const errors = results.filter((r) => r.action === 'error').length;
      console.log(`[fleet] runners: ${launched} launched, ${running} already running, ${errors} errors`);
    })
    .catch((error) => console.error('[fleet] startup error:', error.message));

  startHealthcheck(targets);

  const server = createServer(targets);
  server.listen(parseListenPort(process.env.STATUS_PORT), '0.0.0.0');
  console.log(`[fleet] dashboard listening on :${parseListenPort(process.env.STATUS_PORT)}`);
}

module.exports = {
  createServer, loadTargets, normalizeTarget, parseLabels, parseListenPort,
  slugify, targetHasRepoFeed, normalizeAutocompleteItems, resolveAutocompleteToken,
  validateTargetFormInput, buildAutocompleteCacheKey, readAutocompleteCache,
  writeAutocompleteCache, withAutocompleteCache, clearAutocompleteCache,
  loadPersistedTargets, saveTargets, ensureRunnersForTarget,
};

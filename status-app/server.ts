const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { URL } = require('url');
export {};

type JsonResponse = { statusCode: number; body: any };
type TextResponse = { statusCode: number; body: string };
type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  [key: string]: any;
};
type CreateServerOptions = {
  ensureRunnersForTargetFn?: typeof ensureRunnersForTarget;
  getStatusFn?: typeof getStatus;
  githubOwnerSuggestionsFn?: typeof githubOwnerSuggestions;
  githubRepoSuggestionsFn?: typeof githubRepoSuggestions;
  listRunJobsFn?: typeof listRunJobs;
  rerunFailedJobsFn?: typeof rerunFailedJobs;
  rerunJobFn?: typeof rerunJob;
  rerunWorkflowRunFn?: typeof rerunWorkflowRun;
  saveTargetsFn?: typeof saveTargets;
  stopRunnersForTargetFn?: typeof stopRunnersForTarget;
};

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
function resolveClientDistDir() {
  const candidates = [
    path.join(__dirname, '..', 'frontend', 'dist'),
    path.join(__dirname, '..', '..', 'frontend', 'dist'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

const CLIENT_DIST_DIR = resolveClientDistDir();

/* ── Utilities ──────────────────────────────────────────────────────── */

function collectJson(res, resolve: (value: JsonResponse) => void, reject: (reason?: unknown) => void) {
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

function collectText(res, resolve: (value: TextResponse) => void, reject: (reason?: unknown) => void) {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
  res.on('error', reject);
}

function httpRequest(handler, options: RequestOptions, body?: string) {
  return new Promise<JsonResponse>((resolve, reject) => {
    const req = handler.request(options, (r) => collectJson(r, resolve, reject));
    req.on('error', reject);
    if (body) { req.write(body); }
    req.end();
  });
}

function httpRequestText(handler, options: RequestOptions) {
  return new Promise<TextResponse>((resolve, reject) => {
    const req = handler.request(options, (r) => collectText(r, resolve, reject));
    req.on('error', reject);
    req.end();
  });
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
/* c8 ignore start */

function githubRequest(token, ghPath, { method = 'GET' }: RequestOptions = {}) {
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

async function github(token, ghPath, options?) {
  const response = await githubRequest(token, ghPath, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`GitHub API ${response.statusCode}: ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  return response.body;
}

/* ── Docker API ─────────────────────────────────────────────────────── */

function docker(dPath, { method = 'GET', body, headers = {} }: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<JsonResponse>((resolve, reject) => {
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
/* c8 ignore stop */

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

function deriveTargetBaseName(scope, owner, repo) {
  const ownerName = String(owner || '').trim();
  const repoName = String(repo || '').trim();
  if (scope === 'repo' && ownerName && repoName) {
    return `${ownerName}/${repoName}`;
  }
  return ownerName || repoName || '';
}

function normalizeTarget(input, env = process.env) {
  const scope = String(input.scope || 'org').toLowerCase();
  const owner = input.owner || input.org || '';
  const repo = input.repo || '';
  const derivedName = deriveTargetBaseName(scope, owner, repo);
  const id = slugify(input.id || input.name || derivedName || `target-${Date.now()}`);
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
    id, name: input.name || derivedName || id, scope, owner, repo, accessToken: token,
    labels, runnersCount, runnerImage: image, runnerWorkdir: workdir,
    dindImage, runnerGroup: input.runnerGroup || '',
    description: input.description || '',
  };
}

/* c8 ignore start */
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
/* c8 ignore stop */

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

function normalizeAccessibleOwners(user, orgs) {
  return normalizeAutocompleteItems([
    user?.login,
    ...(Array.isArray(orgs) ? orgs.map((org) => org.login) : []),
  ]);
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
  const labels = parseLabels(input.labels || '');
  const errors = [];
  const slugPattern = /^[A-Za-z0-9_.-]+$/;

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

/* c8 ignore start */
async function githubOwnerSuggestions(token, q = '') {
  const query = String(q || '').trim();
  if (!token) throw new Error('Missing ACCESS_TOKEN for owner lookup');
  const cacheKey = buildAutocompleteCacheKey('owners', token, [query]);

  return withAutocompleteCache(cacheKey, async () => {
    const [user, orgs] = await Promise.all([
      github(token, '/user'),
      github(token, '/user/orgs?per_page=100'),
    ]);

    return normalizeAutocompleteItems(normalizeAccessibleOwners(user, orgs), query);
  });
}

async function githubRepoSuggestions(token, owner, q = '') {
  const query = String(q || '').trim();
  const ownerName = String(owner || '').trim();
  if (!token) throw new Error('Missing ACCESS_TOKEN for repo lookup');
  if (!ownerName) throw new Error('Owner / Org is required for repo lookup');
  const cacheKey = buildAutocompleteCacheKey('repos', token, [ownerName, query]);

  return withAutocompleteCache(cacheKey, async () => {
    const [user, orgs] = await Promise.all([
      github(token, '/user'),
      github(token, '/user/orgs?per_page=100'),
    ]);
    const accessibleOwners = normalizeAccessibleOwners(user, orgs);
    const allowedOwners = new Set(accessibleOwners.map((item) => item.toLowerCase()));
    if (!allowedOwners.has(ownerName.toLowerCase())) return [];

    if (String(user?.login || '').toLowerCase() === ownerName.toLowerCase()) {
      const userRepos = await github(token, '/user/repos?per_page=100&affiliation=owner');
      return normalizeAutocompleteItems((Array.isArray(userRepos) ? userRepos : []).map((repo) => repo.name), query);
    }

    const orgRepos = await github(token, `/orgs/${encodeURIComponent(ownerName)}/repos?per_page=100&type=all`);
    return normalizeAutocompleteItems((Array.isArray(orgRepos) ? orgRepos : []).map((repo) => repo.name), query);
  });
}
/* c8 ignore stop */

/* ── Persistent Runner Management ────────────────────────────────────── */
/* c8 ignore start */

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
/* c8 ignore stop */

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function renderClientShellFallback() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub Runner Fleet</title></head><body><div id="root"></div></body></html>';
}

function createServer(initialTargets, options: CreateServerOptions = {}) {
  const app = express();
  let targets = [...initialTargets];
  const {
    ensureRunnersForTargetFn = ensureRunnersForTarget,
    getStatusFn = getStatus,
    githubOwnerSuggestionsFn = githubOwnerSuggestions,
    githubRepoSuggestionsFn = githubRepoSuggestions,
    listRunJobsFn = listRunJobs,
    rerunFailedJobsFn = rerunFailedJobs,
    rerunJobFn = rerunJob,
    rerunWorkflowRunFn = rerunWorkflowRun,
    saveTargetsFn = saveTargets,
    stopRunnersForTargetFn = stopRunnersForTarget,
  } = options;

  function resolveTarget(id) {
    return targets.find((t) => t.id === id);
  }

  app.use(express.json());

  app.post('/api/targets', asyncRoute(async (req, res) => {
    const input = req.body || {};
    const validation = validateTargetFormInput(input);
    if (!validation.valid) {
      res.status(400).json({ error: validation.errors.join(' ') });
      return;
    }

    input.accessToken = input.accessToken || process.env.ACCESS_TOKEN;
    const target = normalizeTarget(input);
    if (targets.find((item) => item.id === target.id)) {
      res.status(409).json({ error: `Target "${target.id}" already exists` });
      return;
    }

    targets.push(target);
    saveTargetsFn(targets);
    ensureRunnersForTargetFn(target).catch((error) => console.error('[fleet] launch error:', error.message));
    res.status(201).json(target);
  }));

  app.delete('/api/targets/:targetId', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    await stopRunnersForTargetFn(target.id, target.runnersCount);
    targets = targets.filter((item) => item.id !== target.id);
    saveTargetsFn(targets);
    res.json({ removed: target.id });
  }));

  app.post('/api/targets/:targetId/restart', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    await stopRunnersForTargetFn(target.id, target.runnersCount);
    const results = await ensureRunnersForTargetFn(target);
    res.json(results);
  }));

  app.post('/api/targets/:targetId/launch', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const results = await ensureRunnersForTargetFn(target);
    res.json(results);
  }));

  app.get('/api/targets/:targetId/runs/:runId/jobs', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json(await listRunJobsFn(target, req.params.runId));
  }));

  app.post('/api/targets/:targetId/runs/:runId/rerun', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json(await rerunWorkflowRunFn(target, req.params.runId));
  }));

  app.post('/api/targets/:targetId/runs/:runId/rerun-failed', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json(await rerunFailedJobsFn(target, req.params.runId));
  }));

  app.post('/api/targets/:targetId/jobs/:jobId/rerun', asyncRoute(async (req, res) => {
    const target = resolveTarget(req.params.targetId);
    if (!target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.json(await rerunJobFn(target, req.params.jobId));
  }));

  app.get('/api/github/owners', asyncRoute(async (req, res) => {
    const token = resolveAutocompleteToken(targets, String(req.query.targetId || ''));
    const owners = await githubOwnerSuggestionsFn(token, String(req.query.q || ''));
    res.json(owners);
  }));

  app.get('/api/github/repos', asyncRoute(async (req, res) => {
    const owner = String(req.query.owner || '').trim();
    if (!owner) {
      res.status(400).json({ error: 'Owner / Org is required.' });
      return;
    }

    const token = resolveAutocompleteToken(targets, String(req.query.targetId || ''));
    const repos = await githubRepoSuggestionsFn(token, owner, String(req.query.q || ''));
    res.json(repos);
  }));

  app.get('/api/status', asyncRoute(async (_req, res) => {
    res.json(await getStatusFn(targets));
  }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use('/assets', express.static(path.join(CLIENT_DIST_DIR, 'assets'), {
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
  }));

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get(/.*/, (_req, res) => {
    const clientIndexPath = path.join(CLIENT_DIST_DIR, 'index.html');
    if (!fs.existsSync(clientIndexPath)) {
      res.status(200).type('html').send(renderClientShellFallback());
      return;
    }
    res.sendFile(clientIndexPath);
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: error.message });
  });

  return http.createServer(app);
}

/* ── Healthcheck Loop (restart crashed runners only) ─────────────── */
/* c8 ignore start */

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
/* c8 ignore stop */

module.exports = {
  createServer, loadTargets, normalizeTarget, parseLabels, parseListenPort,
  slugify, targetHasRepoFeed, normalizeAutocompleteItems, normalizeAccessibleOwners, resolveAutocompleteToken,
  validateTargetFormInput, buildAutocompleteCacheKey, readAutocompleteCache,
  writeAutocompleteCache, withAutocompleteCache, clearAutocompleteCache,
  loadPersistedTargets, saveTargets, ensureRunnersForTarget, resolveClientDistDir,
};

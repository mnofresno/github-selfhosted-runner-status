const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  buildCleanupPlan,
  createCleanupRuntime,
  executeFleetCleanupPlan,
  getCleanupStatus,
  shouldRunCleanup,
  withCleanupLock,
} = require('./cleanup');

const DEFAULT_PORT = 8080;
const DEFAULT_WORKDIR = '/tmp/github-runner';
const DEFAULT_DIND_IMAGE = 'docker:27-dind';
const DEFAULT_RECONCILE_INTERVAL_MS = Number.parseInt(process.env.RECONCILE_INTERVAL_MS || '5000', 10);
const CLEANUP_ENABLED = String(process.env.CLEANUP_ENABLED || 'true').toLowerCase() !== 'false';
const CLEANUP_INTERVAL_MS = Math.max(60_000, Number.parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10));
const DEFAULT_STACK_GRACE_MS = Number.parseInt(process.env.STACK_GRACE_MS || '30000', 10);
const DEFAULT_MAX_RUNNERS_PER_TARGET = Math.max(1, Number.parseInt(process.env.MAX_RUNNERS_PER_TARGET || '2', 10));
const GITHUB_API_CACHE_MS = Math.max(0, Number.parseInt(process.env.GITHUB_API_CACHE_MS || '300000', 10));
let cleanupRuntime = createCleanupRuntime();
const githubApiCache = new Map();

function githubCacheKey(token, path) {
  return `${token}:${path}`;
}

function githubCacheGet(token, path) {
  const entry = githubApiCache.get(githubCacheKey(token, path));
  if (entry && entry.expires > Date.now()) {
    return entry.value;
  }
  githubApiCache.delete(githubCacheKey(token, path));
  return null;
}

function githubCacheSet(token, path, value) {
  githubApiCache.set(githubCacheKey(token, path), {
    expires: Date.now() + GITHUB_API_CACHE_MS,
    value,
  });
}

async function githubCached(token, path) {
  const cached = githubCacheGet(token, path);
  if (cached) {
    return cached;
  }
  const value = await github(token, path);
  githubCacheSet(token, path, value);
  return value;
}

function filterAutocompleteValues(items, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return !needle || key.includes(needle);
    })
    .sort((left, right) => left.localeCompare(right));
}

async function githubOwnerSuggestions(token, query = '') {
  const [user, orgs] = await Promise.all([
    githubCached(token, '/user'),
    githubCached(token, '/user/orgs?per_page=100'),
  ]);
  const owners = [
    user?.login,
    ...(Array.isArray(orgs) ? orgs.map((org) => org.login) : []),
  ];
  return filterAutocompleteValues(owners, query);
}

async function githubRepoSuggestions(token, owner, query = '') {
  const ownerName = String(owner || '').trim();
  if (!ownerName) {
    return [];
  }

  const accessibleOwners = await githubOwnerSuggestions(token);
  const allowedOwners = new Set(accessibleOwners.map((item) => item.toLowerCase()));
  if (!allowedOwners.has(ownerName.toLowerCase())) {
    return [];
  }

  const currentUser = await githubCached(token, '/user');
  let repos = [];
  if (String(currentUser?.login || '').toLowerCase() === ownerName.toLowerCase()) {
    const userRepos = await githubCached(token, '/user/repos?per_page=100&affiliation=owner');
    repos = (Array.isArray(userRepos) ? userRepos : []).map((repo) => repo.name);
  } else {
    const orgRepos = await githubCached(token, `/orgs/${encodeURIComponent(ownerName)}/repos?per_page=100&type=all`);
    repos = (Array.isArray(orgRepos) ? orgRepos : []).map((repo) => repo.name);
  }

  return filterAutocompleteValues(repos, query);
}

const MANAGED_LABEL = 'io.github-runner-fleet.managed';
const MANAGED_TARGET_LABEL = 'io.github-runner-fleet.target-id';
const MANAGED_RUNNER_LABEL = 'io.github-runner-fleet.runner-name';
const MANAGED_ROLE_LABEL = 'io.github-runner-fleet.role';
const MANAGED_STACK_LABEL = 'io.github-runner-fleet.stack-id';
const LEGACY_MANAGED_LABEL = 'io.github-selfhosted.managed';
const LEGACY_MANAGED_TARGET_LABEL = 'io.github-selfhosted.target-id';
const LEGACY_MANAGED_RUNNER_LABEL = 'io.github-selfhosted.runner-name';

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
    const req = handler.request(options, (res) => collectJson(res, resolve, reject));
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function httpRequestText(handler, options) {
  return new Promise((resolve, reject) => {
    const req = handler.request(options, (res) => collectText(res, resolve, reject));
    req.on('error', reject);
    req.end();
  });
}

function githubRequest(token, path, { method = 'GET' } = {}) {
  return httpRequest(https, {
    hostname: 'api.github.com',
    path,
    method,
    headers: {
      'User-Agent': 'runner-status',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

async function github(token, path, options) {
  const response = await githubRequest(token, path, options);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`GitHub API ${response.statusCode}: ${JSON.stringify(response.body).slice(0, 200)}`);
  }
  return response.body;
}

function docker(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      path,
      method,
      headers,
    }, (res) => collectJson(res, resolve, reject));
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function dockerText(path) {
  return httpRequestText(http, {
    socketPath: '/var/run/docker.sock',
    path,
    method: 'GET',
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

function parseListenPort(value) {
  const candidate = String(value || '').trim();
  if (/^\d+$/.test(candidate)) {
    return Number.parseInt(candidate, 10);
  }
  return DEFAULT_PORT;
}

function managedLabelValue(labels, currentKey, legacyKey) {
  return labels?.[currentKey] || labels?.[legacyKey] || '';
}

function isManagedResource(labels) {
  return labels?.[MANAGED_LABEL] === 'true' || labels?.[LEGACY_MANAGED_LABEL] === 'true';
}

function isManagedRunnerResource(labels) {
  if (labels?.[MANAGED_LABEL] === 'true') {
    return labels?.[MANAGED_ROLE_LABEL] === 'runner';
  }
  return labels?.[LEGACY_MANAGED_LABEL] === 'true';
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseRepoUrl(repoUrl) {
  const match = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) {
    return { owner: '', repo: '' };
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
  };
}

function parseLabels(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTargetsJson(raw) {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('RUNNER_TARGETS_JSON must be a JSON array');
  }
  return parsed;
}

function normalizeTarget(input, env, index) {
  const fallbackScope = input.scope || 'repo';
  const fallbackId = input.id || input.name || `${fallbackScope}-${index + 1}`;
  const parsedRepo = parseRepoUrl(input.repoUrl || input.repositoryUrl || input.REPO_URL || '');
  const owner = input.owner || input.org || input.orgName || input.ORG_NAME || parsedRepo.owner;
  const repo = input.repo || input.repoName || parsedRepo.repo;
  const scope = String(fallbackScope).toLowerCase();
  const id = slugify(fallbackId);
  const labels = parseLabels(input.labels || input.LABELS || env.LABELS);
  const token = input.accessToken || input.ACCESS_TOKEN || env.ACCESS_TOKEN || '';
  const image = input.runnerImage || input.RUNNER_IMAGE || env.RUNNER_IMAGE || 'myoung34/github-runner:latest';
  const workdir = input.runnerWorkdir || input.RUNNER_WORKDIR || env.RUNNER_WORKDIR || DEFAULT_WORKDIR;
  const dindImage = input.dindImage || input.DIND_IMAGE || env.DIND_IMAGE || DEFAULT_DIND_IMAGE;
  const name = input.name || id;
  const parsedMaxRunners = Number.parseInt(
    input.maxRunners || input.MAX_RUNNERS_PER_TARGET || env.MAX_RUNNERS_PER_TARGET || DEFAULT_MAX_RUNNERS_PER_TARGET,
    10,
  );
  const maxRunners = Math.max(1, Number.isNaN(parsedMaxRunners) ? DEFAULT_MAX_RUNNERS_PER_TARGET : parsedMaxRunners);

  if (!id) {
    throw new Error(`Runner target #${index + 1} is missing an id or name`);
  }
  if (!token) {
    throw new Error(`Runner target "${id}" is missing accessToken or ACCESS_TOKEN`);
  }
  if (!['repo', 'org'].includes(scope)) {
    throw new Error(`Runner target "${id}" has unsupported scope "${scope}"`);
  }
  if (scope === 'repo' && (!owner || !repo)) {
    throw new Error(`Runner target "${id}" requires owner and repo`);
  }
  if (scope === 'org' && !owner) {
    throw new Error(`Runner target "${id}" requires owner/org`);
  }

  return {
    id,
    name,
    scope,
    owner,
    repo,
    repoUrl: owner && repo ? `https://github.com/${owner}/${repo}` : '',
    accessToken: token,
    labels,
    runnerImage: image,
    runnerWorkdir: workdir,
    dindImage,
    maxRunners,
    runnerGroup: input.runnerGroup || input.RUNNER_GROUP || '',
    runnerNamePrefix: slugify(input.runnerNamePrefix || `${id}-runner`) || 'runner',
    default: Boolean(input.default),
    description: input.description || '',
  };
}

function loadTargets(env = process.env) {
  const configured = parseTargetsJson(env.RUNNER_TARGETS_JSON);
  if (configured.length) {
    return configured.map((target, index) => normalizeTarget(target, env, index));
  }

  if (!env.REPO_URL || !env.ACCESS_TOKEN) {
    throw new Error('Define RUNNER_TARGETS_JSON or legacy REPO_URL/ACCESS_TOKEN variables');
  }

  return [normalizeTarget({
    id: 'default',
    name: 'Default',
    scope: env.RUNNER_SCOPE || 'repo',
    repoUrl: env.REPO_URL,
    accessToken: env.ACCESS_TOKEN,
    labels: env.LABELS,
    runnerImage: env.RUNNER_IMAGE,
    runnerWorkdir: env.RUNNER_WORKDIR,
    runnerGroup: env.RUNNER_GROUP,
    default: true,
  }, env, 0)];
}

function getTargetMap(targets) {
  return new Map(targets.map((target) => [target.id, target]));
}

function targetHasRepoFeed(target) {
  return Boolean(target.owner && target.repo);
}

function managedStackValue(labels) {
  return labels?.[MANAGED_STACK_LABEL]
    || labels?.['io.github-selfhosted.stack-id']
    || labels?.[MANAGED_RUNNER_LABEL]
    || labels?.[LEGACY_MANAGED_RUNNER_LABEL]
    || '';
}

function parseCreatedMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}

async function listManagedContainers() {
  const response = await docker('/containers/json?all=1');
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }

  return response.body
    .filter((container) => isManagedResource(container.Labels))
    .map((container) => ({
      id: container.Id,
      shortId: container.Id.slice(0, 12),
      name: (container.Names?.[0] || '').replace(/^\//, ''),
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
      createdMs: parseCreatedMs(container.Created),
      targetId: managedLabelValue(container.Labels, MANAGED_TARGET_LABEL, LEGACY_MANAGED_TARGET_LABEL),
      runnerName: managedLabelValue(container.Labels, MANAGED_RUNNER_LABEL, LEGACY_MANAGED_RUNNER_LABEL),
      role: container.Labels?.[MANAGED_ROLE_LABEL] || (isManagedRunnerResource(container.Labels) ? 'runner' : 'resource'),
      stackId: managedStackValue(container.Labels) || container.Id,
    }));
}

async function listManagedVolumes() {
  const response = await docker('/volumes');
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }

  return (response.body.Volumes || [])
    .filter((volume) => isManagedResource(volume.Labels))
    .map((volume) => ({
      ...volume,
      createdMs: parseCreatedMs(volume.CreatedAt),
      targetId: managedLabelValue(volume.Labels, MANAGED_TARGET_LABEL, LEGACY_MANAGED_TARGET_LABEL),
      runnerName: managedLabelValue(volume.Labels, MANAGED_RUNNER_LABEL, LEGACY_MANAGED_RUNNER_LABEL),
      stackId: managedStackValue(volume.Labels) || volume.Name,
    }));
}

async function listManagedNetworks() {
  const response = await docker('/networks');
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }

  return response.body
    .filter((network) => isManagedResource(network.Labels))
    .map((network) => ({
      ...network,
      createdMs: parseCreatedMs(network.Created),
      targetId: managedLabelValue(network.Labels, MANAGED_TARGET_LABEL, LEGACY_MANAGED_TARGET_LABEL),
      runnerName: managedLabelValue(network.Labels, MANAGED_RUNNER_LABEL, LEGACY_MANAGED_RUNNER_LABEL),
      stackId: managedStackValue(network.Labels) || network.Name,
    }));
}

function groupManagedStacks(containers, volumes = [], networks = []) {
  const stacks = new Map();

  function ensureStack(resource) {
    const stackId = resource.stackId || resource.id || resource.Name;
    const existing = stacks.get(stackId);
    if (existing) {
      if (!existing.targetId && resource.targetId) {
        existing.targetId = resource.targetId;
      }
      if (!existing.runnerName && resource.runnerName) {
        existing.runnerName = resource.runnerName;
      }
      if (resource.createdMs && (!existing.createdMs || resource.createdMs < existing.createdMs)) {
        existing.createdMs = resource.createdMs;
      }
      return existing;
    }

    const createdMs = resource.createdMs || 0;
    const stack = {
      stackId,
      targetId: resource.targetId || '',
      runnerName: resource.runnerName || '',
      createdMs,
      containers: [],
      volumes: [],
      networks: [],
      runnerContainer: null,
      dindContainer: null,
    };
    stacks.set(stackId, stack);
    return stack;
  }

  for (const container of containers) {
    const stack = ensureStack(container);
    stack.containers.push(container);
    if (container.role === 'runner') {
      stack.runnerContainer = container;
    }
    if (container.role === 'dind') {
      stack.dindContainer = container;
    }
  }

  for (const volume of volumes) {
    const stack = ensureStack(volume);
    stack.volumes.push(volume);
  }

  for (const network of networks) {
    const stack = ensureStack(network);
    stack.networks.push(network);
  }

  return Array.from(stacks.values())
    .map((stack) => ({
      ...stack,
      createdMs: stack.createdMs || 0,
      state: stack.runnerContainer?.state || stack.dindContainer?.state || 'unknown',
      status: stack.runnerContainer?.status || stack.dindContainer?.status || 'unknown',
      name: stack.runnerContainer?.name || stack.runnerName || stack.stackId,
    }))
    .sort((left, right) => (left.createdMs || 0) - (right.createdMs || 0));
}

function localRunnersFromStacks(targetId, stacks) {
  return stacks
    .filter((stack) => !targetId || stack.targetId === targetId)
    .map((stack) => ({
      id: stack.runnerContainer?.id || stack.stackId,
      shortId: (stack.runnerContainer?.shortId || stack.stackId).slice(0, 12),
      name: stack.name,
      image: stack.runnerContainer?.image || '',
      state: stack.state,
      status: stack.status,
      created: Math.floor((stack.createdMs || 0) / 1000),
      createdMs: stack.createdMs || 0,
      targetId: stack.targetId,
      runnerName: stack.runnerName,
      stackId: stack.stackId,
      networkName: stack.networks[0]?.Name || '',
      volumeNames: stack.volumes.map((volume) => volume.Name),
    }));
}

async function listManagedStacks() {
  const [containers, volumes, networks] = await Promise.all([
    listManagedContainers(),
    listManagedVolumes(),
    listManagedNetworks(),
  ]);

  return groupManagedStacks(containers, volumes, networks);
}

async function listManagedRunnerContainers(targetId) {
  return localRunnersFromStacks(targetId, await listManagedStacks());
}

function formatRunnerName(target) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${target.runnerNamePrefix}-${stamp}`;
}

function dindCommand() {
  return [
    'dockerd',
    '--host=tcp://127.0.0.1:2375',
    '--host=unix:///var/run/docker.sock',
    '--ip=127.0.0.1',
  ];
}

function buildManagedLabels(target, runnerName, role, stackId) {
  return {
    [MANAGED_LABEL]: 'true',
    [MANAGED_TARGET_LABEL]: target.id,
    [MANAGED_RUNNER_LABEL]: runnerName,
    [MANAGED_ROLE_LABEL]: role,
    [MANAGED_STACK_LABEL]: stackId,
  };
}

function buildRunnerContainerSpec(target, runnerName) {
  const stackId = `${target.id}-${stampFragment()}`;
  const runnerVolumeName = `ghrunner-work-${stackId}`;
  const dockerVolumeName = `ghrunner-docker-${stackId}`;
  const networkName = `ghrunner-net-${stackId}`;
  const labels = [
    ...target.labels,
    `target:${target.id}`,
    `scope:${target.scope}`,
    'ephemeral',
  ].filter(Boolean);
  const env = [
    `ACCESS_TOKEN=${target.accessToken}`,
    `RUNNER_SCOPE=${target.scope}`,
    `RUNNER_NAME=${runnerName}`,
    `RUNNER_WORKDIR=${target.runnerWorkdir}`,
    `LABELS=${labels.join(',')}`,
    'EPHEMERAL=true',
    'DISABLE_AUTO_UPDATE=true',
    'RANDOM_RUNNER_SUFFIX=false',
    'DOCKER_HOST=tcp://127.0.0.1:2375',
  ];

  if (target.scope === 'repo') {
    env.push(`REPO_URL=${target.repoUrl}`);
  } else {
    env.push(`ORG_NAME=${target.owner}`);
  }

  if (target.runnerGroup) {
    env.push(`RUNNER_GROUP=${target.runnerGroup}`);
  }

  return {
    stackId,
    networkName,
    runnerVolumeName,
    dockerVolumeName,
    dindContainerName: dindContainerNameForStack(stackId),
    runnerContainerName: `runner-${stackId}`.slice(0, 63),
    dindBody: {
      Image: target.dindImage,
      Env: ['DOCKER_TLS_CERTDIR='],
      Cmd: dindCommand(),
      Hostname: 'docker',
      Labels: buildManagedLabels(target, runnerName, 'dind', stackId),
      HostConfig: {
        Privileged: true,
        NetworkMode: networkName,
        Binds: [
          `${dockerVolumeName}:/var/lib/docker`,
        ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {},
        },
      },
    },
    runnerBody: {
      Image: target.runnerImage,
      Env: env,
      Labels: buildManagedLabels(target, runnerName, 'runner', stackId),
      HostConfig: {
        NetworkMode: `container:${dindContainerNameForStack(stackId)}`,
        Binds: [
          `${runnerVolumeName}:${target.runnerWorkdir}`,
        ],
      },
    },
  };
}

function stampFragment() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dindContainerNameForStack(stackId) {
  return `docker-${stackId}`.slice(0, 63);
}

async function createVolume(name, labels = {}) {
  const response = await docker('/volumes/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Name: name,
      Labels: {
        [MANAGED_LABEL]: 'true',
        ...labels,
      },
    }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Volume create failed with status ${response.statusCode}`);
  }
}

async function removeVolume(name) {
  const response = await docker(`/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (![204, 404].includes(response.statusCode)) {
    throw new Error(`Volume delete failed with status ${response.statusCode}`);
  }
}

async function listManagedContainersByStack(stackId) {
  const filters = encodeURIComponent(JSON.stringify({
    label: [`${MANAGED_STACK_LABEL}=${stackId}`],
  }));
  const response = await docker(`/containers/json?all=1&filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }
  return response.body;
}

async function listManagedVolumesByStack(stackId) {
  const filters = encodeURIComponent(JSON.stringify({
    label: [`${MANAGED_STACK_LABEL}=${stackId}`],
  }));
  const response = await docker(`/volumes?filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }
  return response.body.Volumes || [];
}

async function createNetwork(name, labels = {}) {
  const response = await docker('/networks/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Name: name,
      Driver: 'bridge',
      Labels: {
        [MANAGED_LABEL]: 'true',
        ...labels,
      },
    }),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Network create failed with status ${response.statusCode}`);
  }
}

async function listManagedNetworksByStack(stackId) {
  const filters = encodeURIComponent(JSON.stringify({
    label: [`${MANAGED_STACK_LABEL}=${stackId}`],
  }));
  const response = await docker(`/networks?filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }
  return response.body;
}

async function removeNetwork(name) {
  const response = await docker(`/networks/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (![204, 404].includes(response.statusCode)) {
    throw new Error(`Network delete failed with status ${response.statusCode}`);
  }
}

async function createContainer(name, body) {
  const response = await docker(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Container create failed with status ${response.statusCode}`);
  }
  return response.body.Id;
}

async function startContainer(containerId) {
  const response = await docker(`/containers/${containerId}/start`, { method: 'POST' });
  if (![204, 304].includes(response.statusCode)) {
    throw new Error(`Container start failed with status ${response.statusCode}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDockerDaemon(containerId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await dockerText(`/containers/${containerId}/logs?stdout=1&stderr=1&tail=100`);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const logs = response.body || '';
      if (
        logs.includes('API listen on [::]:2375')
        || logs.includes('API listen on 0.0.0.0:2375')
        || logs.includes('API listen on 127.0.0.1:2375')
        || logs.includes('Daemon has completed initialization')
      ) {
        return;
      }
    }
    await sleep(500);
  }
  throw new Error(`Docker daemon did not become ready for container ${containerId.slice(0, 12)}`);
}

async function removeManagedStack(stackId) {
  const [containers, volumes, networks] = await Promise.all([
    listManagedContainersByStack(stackId).catch(() => []),
    listManagedVolumesByStack(stackId).catch(() => []),
    listManagedNetworksByStack(stackId).catch(() => []),
  ]);

  for (const container of containers) {
    await docker(`/containers/${container.Id}?force=1`, { method: 'DELETE' }).catch(() => {});
  }
  for (const volume of volumes) {
    await removeVolume(volume.Name).catch(() => {});
  }
  for (const network of networks) {
    await removeNetwork(network.Name).catch(() => {});
  }
}

async function launchRunner(target) {
  const runnerName = formatRunnerName(target);
  const spec = buildRunnerContainerSpec(target, runnerName);
  const stackLabels = {
    [MANAGED_STACK_LABEL]: spec.stackId,
    [MANAGED_TARGET_LABEL]: target.id,
    [MANAGED_RUNNER_LABEL]: runnerName,
  };

  try {
    await createNetwork(spec.networkName, stackLabels);
    await createVolume(spec.runnerVolumeName, stackLabels);
    await createVolume(spec.dockerVolumeName, stackLabels);

    const dindContainerId = await createContainer(spec.dindContainerName, spec.dindBody);
    await startContainer(dindContainerId);
    await waitForDockerDaemon(dindContainerId);

    const containerId = await createContainer(spec.runnerContainerName, spec.runnerBody);
    await startContainer(containerId);

    return {
      targetId: target.id,
      runnerName,
      containerId,
      containerName: spec.runnerContainerName,
      volumeName: spec.runnerVolumeName,
      stackId: spec.stackId,
    };
  } catch (error) {
    await removeManagedStack(spec.stackId).catch(() => {});
    throw error;
  }
}

async function inspectContainer(containerId) {
  const response = await docker(`/containers/${containerId}/json`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Container inspect failed with status ${response.statusCode}`);
  }
  return response.body;
}

async function removeManagedRunner(containerId) {
  const inspected = await inspectContainer(containerId);
  const stackId = inspected.Config?.Labels?.[MANAGED_STACK_LABEL];

  if (stackId) {
    await removeManagedStack(stackId);
    return {
      containerId,
      stackId,
      removedVolumes: [],
    };
  }

  const volumeNames = (inspected.Mounts || [])
    .filter((mount) => mount.Type === 'volume' && mount.Name)
    .map((mount) => mount.Name);

  const removeResponse = await docker(`/containers/${containerId}?force=1`, { method: 'DELETE' });
  if (![204, 404].includes(removeResponse.statusCode)) {
    throw new Error(`Container delete failed with status ${removeResponse.statusCode}`);
  }

  for (const volumeName of volumeNames) {
    await removeVolume(volumeName).catch(() => {});
  }

  return {
    containerId,
    removedVolumes: volumeNames,
  };
}

async function githubRunnersForTarget(target) {
  if (target.scope === 'repo') {
    const payload = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runners`);
    return payload.runners || [];
  }

  const payload = await github(target.accessToken, `/orgs/${target.owner}/actions/runners`);
  return payload.runners || [];
}

async function latestRunsForTarget(target) {
  if (!targetHasRepoFeed(target)) {
    return [];
  }

  const payload = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs?per_page=8`);
  return (payload.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    created_at: run.created_at,
  }));
}

async function listRunJobs(target, runId) {
  if (!targetHasRepoFeed(target)) {
    return [];
  }

  const jobs = await github(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/jobs`);
  return (jobs.jobs || []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    runner_name: job.runner_name,
    html_url: job.html_url,
  }));
}

async function rerunWorkflowRun(target, runId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Run rerun failed with status ${response.statusCode}`);
  }
  return { runId, scope: 'run', statusCode: response.statusCode };
}

async function rerunFailedJobs(target, runId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Failed-jobs rerun failed with status ${response.statusCode}`);
  }
  return { runId, scope: 'failed-jobs', statusCode: response.statusCode };
}

async function rerunJob(target, jobId) {
  const response = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/jobs/${jobId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Job rerun failed with status ${response.statusCode}`);
  }
  return { jobId, scope: 'job', statusCode: response.statusCode };
}

function activeRunsFromLatestRuns(latestRuns) {
  return latestRuns.filter((run) => run.status !== 'completed');
}

async function activeJobsFromRuns(target, runs) {
  const runJobs = await Promise.all(runs.map((run) => listRunJobs(target, run.id)));
  return runJobs
    .flat()
    .filter((job) => job.status !== 'completed');
}

function desiredRunnerCountForTarget({ target, activeRuns, activeJobs, managedStacks = [] }) {
  const managedRunnerNames = new Set(managedStacks.map((stack) => stack.runnerName).filter(Boolean));
  const queuedJobs = activeJobs.filter((job) => !job.runner_name);
  const assignedManagedJobs = activeJobs.filter((job) => managedRunnerNames.has(job.runner_name));
  let desired = queuedJobs.length + assignedManagedJobs.length;

  if (desired === 0 && activeRuns.length) {
    desired = managedStacks.length ? managedStacks.length : 1;
  }

  return Math.min(target.maxRunners || DEFAULT_MAX_RUNNERS_PER_TARGET, desired);
}

function shouldRemoveManagedStack(stack, snapshot, { now = Date.now(), graceMs = DEFAULT_STACK_GRACE_MS } = {}) {
  const runnerState = String(stack.runnerContainer?.state || '').toLowerCase();
  const dindState = String(stack.dindContainer?.state || '').toLowerCase();
  const ageMs = Math.max(0, now - (stack.createdMs || now));

  if (!stack.runnerContainer || !stack.dindContainer) {
    return true;
  }

  if (['dead', 'exited', 'removing'].includes(runnerState) || ['dead', 'exited', 'removing'].includes(dindState)) {
    return true;
  }

  if (!snapshot.activeRuns.length) {
    return ageMs >= graceMs;
  }

  const activeRunnerNames = new Set(snapshot.activeJobs.map((job) => job.runner_name).filter(Boolean));
  if (activeRunnerNames.has(stack.runnerName)) {
    return false;
  }

  return ageMs >= graceMs && snapshot.managedStacks.length > snapshot.desiredRunnerCount;
}

async function collectTargetSnapshot(target, allStacks = null) {
  const [githubRunners, latestRuns, managedStacksAll] = await Promise.all([
    githubRunnersForTarget(target),
    latestRunsForTarget(target),
    allStacks ? Promise.resolve(allStacks) : listManagedStacks(),
  ]);

  const managedStacks = managedStacksAll.filter((stack) => stack.targetId === target.id);
  const activeRuns = activeRunsFromLatestRuns(latestRuns);
  const activeJobs = activeRuns.length ? await activeJobsFromRuns(target, activeRuns) : [];
  const desiredRunnerCount = desiredRunnerCountForTarget({
    target,
    activeRuns,
    activeJobs,
    managedStacks,
  });

  return {
    id: target.id,
    name: target.name,
    scope: target.scope,
    owner: target.owner,
    repo: target.repo,
    repository: targetHasRepoFeed(target) ? `${target.owner}/${target.repo}` : target.owner,
    description: target.description,
    labels: target.labels,
    maxRunners: target.maxRunners,
    managedStacks,
    localRunners: localRunnersFromStacks(target.id, managedStacks),
    githubRunners: githubRunners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      status: runner.status,
      busy: runner.busy,
      labels: (runner.labels || []).map((label) => label.name),
      os: runner.os,
    })),
    activeRun: activeRuns[0] || null,
    activeRuns,
    activeJobs,
    latestRuns,
    desiredRunnerCount,
  };
}

async function killMatchingManagedRunner(runnerNames) {
  if (!runnerNames.length) {
    return [];
  }

  const stacks = await listManagedStacks();
  const targets = stacks.filter((stack) => runnerNames.includes(stack.runnerName));
  const results = [];

  for (const stack of targets) {
    await removeManagedStack(stack.stackId);
    results.push({
      containerId: stack.runnerContainer?.id || '',
      containerName: stack.runnerContainer?.name || '',
      stackId: stack.stackId,
      statusCode: 204,
    });
  }

  return results;
}

async function forceCancelRun(target, runId) {
  const result = {
    runId,
    github: null,
    runnerKill: [],
  };

  const forceCancel = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/force-cancel`, { method: 'POST' });
  if ([202, 204, 409].includes(forceCancel.statusCode)) {
    result.github = {
      endpoint: 'force-cancel',
      statusCode: forceCancel.statusCode,
    };
  } else if (forceCancel.statusCode === 404 || forceCancel.statusCode === 422) {
    const fallback = await githubRequest(target.accessToken, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/cancel`, { method: 'POST' });
    if (![202, 204, 409].includes(fallback.statusCode)) {
      throw new Error(`Cancel request failed with status ${fallback.statusCode}`);
    }
    result.github = {
      endpoint: 'cancel',
      statusCode: fallback.statusCode,
    };
  } else {
    throw new Error(`Force cancel failed with status ${forceCancel.statusCode}`);
  }

  const jobs = await listRunJobs(target, runId);
  const runnerNames = jobs
    .map((job) => job.runner_name)
    .filter(Boolean);

  const killedManaged = await killMatchingManagedRunner(runnerNames);
  if (!killedManaged.length) {
    result.runnerKill = [{ status: 'runner-not-found' }];
    return result;
  }

  result.runnerKill = killedManaged;
  return result;
}

async function reconcileTarget(target) {
  const managedStacksAll = await listManagedStacks();
  const snapshot = await collectTargetSnapshot(target, managedStacksAll);
  const staleStacks = snapshot.managedStacks.filter((stack) => shouldRemoveManagedStack(stack, snapshot));
  const removedStackIds = new Set();

  for (const stack of staleStacks) {
    await removeManagedStack(stack.stackId);
    removedStackIds.add(stack.stackId);
  }

  let currentCount = snapshot.managedStacks.length - removedStackIds.size;
  while (currentCount < snapshot.desiredRunnerCount) {
    await launchRunner(target);
    currentCount += 1;
  }

  if (currentCount > snapshot.desiredRunnerCount) {
    const activeRunnerNames = new Set(snapshot.activeJobs.map((job) => job.runner_name).filter(Boolean));
    const removableStacks = snapshot.managedStacks
      .filter((stack) => !removedStackIds.has(stack.stackId))
      .filter((stack) => !activeRunnerNames.has(stack.runnerName))
      .sort((left, right) => (left.createdMs || 0) - (right.createdMs || 0));

    for (const stack of removableStacks) {
      if (currentCount <= snapshot.desiredRunnerCount) {
        break;
      }
      if (Date.now() - (stack.createdMs || Date.now()) < DEFAULT_STACK_GRACE_MS) {
        continue;
      }
      await removeManagedStack(stack.stackId);
      currentCount -= 1;
    }
  }

  return snapshot;
}

function createReconciler(targets) {
  let timer = null;
  let running = false;

  async function reconcileOnce() {
    if (running || cleanupRuntime.maintenanceRunning) {
      return { skipped: true };
    }

    running = true;
    try {
      for (const target of targets) {
        await reconcileTarget(target);
      }
      return { ok: true };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) {
      return timer;
    }

    timer = setInterval(() => {
      reconcileOnce().catch((error) => {
        console.error('[runner-status] reconcile failed', error);
      });
    }, DEFAULT_RECONCILE_INTERVAL_MS);
    return timer;
  }

  function stop() {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  }

  return {
    reconcileOnce,
    start,
    stop,
  };
}

async function getTargetStatus(target, allStacks = null) {
  return collectTargetSnapshot(target, allStacks);
}

function snapshotCleanupStatus() {
  return getCleanupStatus(cleanupRuntime);
}

function resetCleanupRuntime() {
  cleanupRuntime = createCleanupRuntime();
}

async function runFleetCleanup(targets, options = {}) {
  const {
    getStatusFn = getStatus,
    ensureRunnersForTargetFn = ensureRunnersForTarget,
  } = options;

  return withCleanupLock(cleanupRuntime, async () => {
    const startedAt = new Date().toISOString();
    const status = await getStatusFn(targets);
    const cleanupDecision = shouldRunCleanup({
      status,
      cleanupState: cleanupRuntime.fleet,
      now: Date.now(),
    });

    if (!cleanupDecision.ok) {
      const skippedResult = {
        mode: 'fleet',
        startedAt,
        finishedAt: new Date().toISOString(),
        skipped: true,
        reason: cleanupDecision.reason,
      };
      cleanupRuntime.fleet.lastResult = skippedResult;
      cleanupRuntime.fleet.lastRunAt = Date.now();
      return skippedResult;
    }

    cleanupRuntime.fleet.running = true;
    cleanupRuntime.fleet.lastStartedAt = startedAt;
    cleanupRuntime.fleet.lastError = null;

    try {
      const [dockerContainers, dockerVolumes, dockerNetworks] = await Promise.all([
        listManagedContainers(),
        listManagedVolumes(),
        listManagedNetworks(),
      ]);
      const plan = buildCleanupPlan({
        status,
        dockerContainers,
        dockerVolumes,
        dockerNetworks,
        now: Date.now(),
      });

      const executeResult = await executeFleetCleanupPlan({
        plan,
        removeStack: async (stackIdValue) => removeManagedStack(stackIdValue),
        reconcileTargets: (targets || []).filter((target) => target.runnersCount > 0),
        ensureRunnersForTarget: ensureRunnersForTargetFn,
      });

      const finishedAt = new Date().toISOString();
      const result = {
        mode: 'fleet',
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        plan,
        ...executeResult,
      };

      cleanupRuntime.fleet.lastRunAt = Date.now();
      cleanupRuntime.fleet.lastResult = result;
      return result;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      cleanupRuntime.fleet.lastRunAt = Date.now();
      cleanupRuntime.fleet.lastError = error.message;
      cleanupRuntime.fleet.lastResult = {
        mode: 'fleet',
        startedAt,
        finishedAt,
        error: error.message,
      };
      throw error;
    } finally {
      cleanupRuntime.fleet.running = false;
    }
  });
}

function startFleetCleanupLoop(targets) {
  if (!CLEANUP_ENABLED) {
    return null;
  }

  return setInterval(() => {
    runFleetCleanup(targets).catch((error) => {
      console.error('[runner-status] cleanup failed', error);
    });
  }, CLEANUP_INTERVAL_MS);
}

async function getStatus(targets) {
  const allStacks = await listManagedStacks();
  const targetStatuses = await Promise.all(targets.map((target) => getTargetStatus(target, allStacks)));
  const managedRunners = localRunnersFromStacks('', allStacks);

  return {
    generatedAt: new Date().toISOString(),
    targets: targetStatuses,
    managedRunners,
    managedStacks: allStacks,
  };
}

function renderLabelList(labels) {
  if (!labels.length) {
    return '<span class="muted">none</span>';
  }
  return labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join('');
}

function renderTone(value, tone) {
  return `<span class="tone tone-${tone}">${escapeHtml(value)}</span>`;
}

function renderManagedRunnerRows(target) {
  if (!target.localRunners.length) {
    return '<tr><td colspan="5">No ephemeral runner stacks currently exist for this target.</td></tr>';
  }

  return target.localRunners.map((runner) => (
    `<tr><td><code>${escapeHtml(runner.runnerName || runner.name)}</code></td><td>${escapeHtml(runner.state)}</td><td>${escapeHtml(runner.status)}</td><td>${escapeHtml(new Date((runner.createdMs || 0) || (runner.created * 1000)).toISOString())}</td><td><button class="danger" data-container-id="${escapeHtml(runner.id)}" data-action="remove-runner">Remove</button></td></tr>`
  )).join('');
}

function renderGithubRunnerRows(target) {
  if (!target.githubRunners.length) {
    return '<tr><td colspan="5">No registered runners found in GitHub for this target.</td></tr>';
  }

  return target.githubRunners.map((runner) => (
    `<tr><td><code>${escapeHtml(runner.name)}</code></td><td>${escapeHtml(runner.status)}</td><td>${runner.busy ? renderTone('busy', 'warn') : renderTone('idle', 'ok')}</td><td>${escapeHtml(runner.os || '-')}</td><td>${renderLabelList(runner.labels)}</td></tr>`
  )).join('');
}

function renderRunRows(target) {
  if (!targetHasRepoFeed(target)) {
    return '<tr><td colspan="6">Run history is unavailable until a repository is configured for this target.</td></tr>';
  }
  if (!target.latestRuns.length) {
    return '<tr><td colspan="6">No recent runs.</td></tr>';
  }

  return target.latestRuns.map((run) => {
    const actions = [];
    if (run.status !== 'completed') {
      actions.push(`<button class="danger" data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="force-cancel">Cancel</button>`);
    } else {
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="show-jobs">Jobs</button>`);
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="rerun-run">Rerun</button>`);
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="rerun-failed">Retry failed</button>`);
    }
    return `<tr><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${run.id}</a></td><td>${escapeHtml(run.event)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.conclusion || '-')}</td><td>${escapeHtml(run.created_at)}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
  }).join('');
}

function renderActiveJobsRows(target) {
  if (!target.activeJobs.length) {
    return '<tr><td colspan="4">No active jobs.</td></tr>';
  }

  return target.activeJobs.map((job) => (
    `<tr><td>${escapeHtml(job.name)}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.conclusion || '-')}</td><td>${escapeHtml(job.runner_name || '-')}</td></tr>`
  )).join('');
}

function renderTargetCard(target) {
  const repositoryLabel = targetHasRepoFeed(target) ? target.repository : target.owner;
  const activeRunCopy = target.activeRuns.length
    ? `${target.activeRuns.length} active run(s)`
    : 'No active runs';

  return `
    <section class="card target-card">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(target.name)}</h2>
          <div class="target-path">${escapeHtml(repositoryLabel)}</div>
        </div>
        <div class="toolbar">
          <span class="scope-chip">${escapeHtml(target.scope)}</span>
          <button data-target-id="${escapeHtml(target.id)}" data-action="launch-runner">Launch runner</button>
        </div>
      </div>
      ${target.description ? `<p class="muted compact">${escapeHtml(target.description)}</p>` : ''}
      <div class="summary-strip">
        <div><span class="summary-label">Ephemeral</span><strong>${target.localRunners.length}</strong></div>
        <div><span class="summary-label">Registered</span><strong>${target.githubRunners.length}</strong></div>
        <div><span class="summary-label">Busy</span><strong>${target.githubRunners.filter((runner) => runner.busy).length}</strong></div>
        <div><span class="summary-label">Demand</span><strong>${target.desiredRunnerCount}/${target.maxRunners}</strong></div>
      </div>
      <div class="meta-grid">
        <div>
          <div class="meta-label">Labels</div>
          <div>${renderLabelList(target.labels)}</div>
        </div>
        <div>
          <div class="meta-label">Scope</div>
          <div>${escapeHtml(target.scope)}</div>
        </div>
      </div>
      <div class="panel-grid">
        <section class="subcard">
          <h3>Ephemeral Runner Stacks</h3>
          <table>
            <thead><tr><th>Runner</th><th>State</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>${renderManagedRunnerRows(target)}</tbody>
          </table>
        </section>
        <section class="subcard">
          <h3>Registered in GitHub</h3>
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Busy</th><th>OS</th><th>Labels</th></tr></thead>
            <tbody>${renderGithubRunnerRows(target)}</tbody>
          </table>
        </section>
      </div>
      <div class="panel-grid">
        <section class="subcard">
          <div class="section-head section-head-tight">
            <h3>Run Feed</h3>
            <span class="muted">${targetHasRepoFeed(target) ? escapeHtml(target.repository) : 'repo controls unavailable'}</span>
          </div>
          <table>
            <thead><tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>${renderRunRows(target)}</tbody>
          </table>
          <div id="jobs-panel-${escapeHtml(target.id)}" class="jobs-panel muted">No completed run selected.</div>
        </section>
        <section class="subcard">
          <div class="section-head section-head-tight">
            <h3>Active Jobs</h3>
            <span class="muted">${activeRunCopy}</span>
          </div>
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th></tr></thead>
            <tbody>${renderActiveJobsRows(target)}</tbody>
          </table>
        </section>
      </div>
    </section>
  `;
}

function render(status) {
  const managedCount = status.managedRunners.length;
  const registeredCount = status.targets.reduce((total, target) => total + target.githubRunners.length, 0);
  const activeRuns = status.targets.reduce((total, target) => total + target.activeRuns.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="20">
  <title>GitHub Runner Fleet</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f4ef;
      --surface: #ffffff;
      --surface-muted: #f7f7f3;
      --border: #d8d5cb;
      --text: #1f2320;
      --muted: #646a64;
      --accent: #285540;
      --accent-soft: #e6efe9;
      --warn: #9a6b16;
      --warn-soft: #fff2cf;
      --danger: #9c3d2d;
      --danger-soft: #fde7e3;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "SF Pro Text", "Segoe UI Variable", "Helvetica Neue", sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1400px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
    .card, .subcard { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
    .card { padding: 20px; }
    .subcard { padding: 16px; }
    .overview { display: grid; gap: 14px; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(140px, 1fr)); align-items: stretch; }
    .metric { padding: 16px; background: var(--surface-muted); border: 1px solid var(--border); border-radius: 10px; }
    .metric strong { display: block; font-size: 28px; margin-top: 6px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .page-head h1, .target-card h2, h3 { margin: 0; font-size: 22px; line-height: 1.15; }
    h3 { font-size: 16px; }
    .page-head p, .compact { margin: 8px 0 0; }
    .muted { color: var(--muted); }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .section-head-tight { align-items: center; margin-bottom: 12px; }
    .toolbar, .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .target-path { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 14px 0; }
    .summary-strip > div { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); }
    .summary-label, .meta-label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .summary-strip strong { font-size: 15px; }
    .meta-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(120px, 1fr); gap: 12px; margin-bottom: 16px; }
    .panel-grid { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 14px; }
    .pill, .scope-chip, .tone { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 8px; font-size: 12px; border: 1px solid var(--border); background: var(--surface-muted); margin: 0 6px 6px 0; }
    .scope-chip { margin: 0; text-transform: lowercase; }
    .tone-ok { color: var(--accent); background: var(--accent-soft); border-color: #c8dccf; }
    .tone-warn { color: var(--warn); background: var(--warn-soft); border-color: #ecdba0; }
    .tone-danger { color: var(--danger); background: var(--danger-soft); border-color: #efc4bc; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid #ebe8de; font-size: 13px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    td { padding-right: 12px; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: "SFMono-Regular", "Consolas", monospace; background: var(--surface-muted); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; }
    button { border: 1px solid #bfc3b6; background: #f5f5f1; color: var(--text); border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button:hover { background: #efefe9; }
    button:disabled { opacity: 0.6; cursor: wait; }
    button.danger { border-color: #d9b1a8; background: var(--danger-soft); color: var(--danger); }
    a { color: var(--accent); text-decoration: none; }
    .jobs-panel { margin-top: 14px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; background: var(--surface-muted); min-height: 48px; }
    #action-status { min-height: 20px; }
    @media (max-width: 1024px) {
      .overview, .summary-strip, .panel-grid, .meta-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="overview">
      <section class="card page-head">
        <h1>GitHub Runner Fleet</h1>
        <p class="muted">Ephemeral-only runner stacks by target, with isolated Docker daemons and repo-level run controls where that scope exists.</p>
        <p class="muted">Updated <code>${escapeHtml(status.generatedAt)}</code></p>
        <p id="action-status" class="muted">Launch creates a fresh runner stack for one target. Remove deletes the runner, dind, network, and volumes for that stack.</p>
      </section>
      <section class="metric"><span>Targets</span><strong>${status.targets.length}</strong></section>
      <section class="metric"><span>Ephemeral runner stacks</span><strong>${managedCount}</strong></section>
      <section class="metric"><span>Registered runners</span><strong>${registeredCount}</strong></section>
    </section>
    <section class="card">
      <div class="section-head section-head-tight">
        <h2>Target navigation helper</h2>
      </div>
      <div class="meta-grid">
        <label>
          <span class="meta-label">Target (token provider)</span>
          <select id="github-target" style="width:100%;" aria-label="Github target selector">
            ${status.targets.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.name)} (${escapeHtml(target.id)})</option>`).join('')}
          </select>
        </label>
        <label>
          <span class="meta-label">Owner / Org</span>
          <input id="github-owner" list="owner-options" type="search" placeholder="Start typing owner/org" autocomplete="off" style="width:100%;" />
          <datalist id="owner-options"></datalist>
        </label>
        <label>
          <span class="meta-label">Repo</span>
          <input id="github-repo" list="repo-options" type="search" placeholder="Start typing repo" autocomplete="off" style="width:100%;" disabled />
          <datalist id="repo-options"></datalist>
        </label>
      </div>
      <div class="toolbar" style="margin-top:8px;">
        <button id="github-refresh-owners">Refresh owners</button>
        <button id="github-refresh-repos" disabled>Refresh repos</button>
        <button id="github-copy-snippet">Copy RUNNER_TARGETS_JSON snippet</button>
      </div>
      <div id="github-helper-status" class="muted">Use this panel to find owner/org + repo names with GitHub-backed autocomplete and get copy/paste target JSON.</div>
    </section>
    <section class="card">
      <div class="section-head section-head-tight">
        <h2>Fleet state</h2>
        <span class="muted">${activeRuns} active run(s) across the tracked repositories</span>
      </div>
      <table>
        <thead><tr><th>Container</th><th>Target</th><th>Runner</th><th>State</th><th>Status</th></tr></thead>
        <tbody>${status.managedRunners.length
          ? status.managedRunners.map((runner) => `<tr><td><code>${escapeHtml(runner.name)}</code></td><td>${escapeHtml(runner.targetId)}</td><td>${escapeHtml(runner.runnerName || '-')}</td><td>${escapeHtml(runner.state)}</td><td>${escapeHtml(runner.status)}</td></tr>`).join('')
          : '<tr><td colspan="5">No ephemeral runner stacks currently exist.</td></tr>'}</tbody>
      </table>
    </section>
    ${status.targets.map((target) => renderTargetCard(target)).join('')}
  </main>
  <script>
    const statusNode = document.getElementById('action-status');

    function setBusy(disabled) {
      Array.from(document.querySelectorAll('button[data-action]')).forEach((item) => { item.disabled = disabled; });
    }

    async function callJson(url, options = {}) {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Unknown error');
      }
      return payload;
    }

    async function githubFetchOwners(targetId, q = '') {
      const queryString = '?targetId=' + encodeURIComponent(targetId) + (q ? '&q=' + encodeURIComponent(q) : '');
      return callJson('/api/github/owners' + queryString);
    }

    async function githubFetchRepos(targetId, owner, q = '') {
      const params = new URLSearchParams({ targetId, owner });
      if (q) params.set('q', q);
      return callJson('/api/github/repos?' + params.toString());
    }

    function setGithubHelperStatus(message, isError = false) {
      const node = document.getElementById('github-helper-status');
      node.textContent = message;
      node.style.color = isError ? 'var(--danger)' : 'var(--muted)';
    }

    async function refreshOwnerOptions() {
      const targetId = document.getElementById('github-target').value;
      setGithubHelperStatus('Loading owner/org list...');
      try {
        const owners = await githubFetchOwners(targetId);
        const ownerDataList = document.getElementById('owner-options');
        ownerDataList.innerHTML = owners.map(function(owner) {
          return '<option value="' + owner + '"></option>';
        }).join('');
        setGithubHelperStatus('Loaded ' + owners.length + ' owner(s).');
      } catch (error) {
        setGithubHelperStatus('Owner lookup failed: ' + error.message, true);
      }
    }

    async function refreshRepoOptions() {
      const targetId = document.getElementById('github-target').value;
      const owner = document.getElementById('github-owner').value.trim();
      if (!owner) {
        setGithubHelperStatus('Select owner/org first.');
        return;
      }
      setGithubHelperStatus('Loading repos for ' + owner + '...');
      try {
        const repos = await githubFetchRepos(targetId, owner);
        const repoDataList = document.getElementById('repo-options');
        repoDataList.innerHTML = repos.map(function(repo) { return '<option value="' + repo + '"></option>'; }).join('');
        document.getElementById('github-repo').disabled = false;
        setGithubHelperStatus('Loaded ' + repos.length + ' repos for ' + owner + '.');
      } catch (error) {
        setGithubHelperStatus('Repo lookup failed: ' + error.message, true);
      }
    }

    function createRunnerTargetSnippet() {
      const targetId = document.getElementById('github-target').value;
      const owner = document.getElementById('github-owner').value.trim();
      const repo = document.getElementById('github-repo').value.trim();
      if (!owner) {
        setGithubHelperStatus('Owner is required to build snippet.', true);
        return;
      }
      const fragment = {
        id: owner + '-' + (repo || 'org') + '-target',
        name: owner + (repo ? '/' + repo : ''),
        scope: repo ? 'repo' : 'org',
        owner,
        repo: repo || undefined,
        accessToken: '<your token or set via env>',
      };
      const snippet = JSON.stringify([fragment], null, 2);
      navigator.clipboard.writeText(snippet).then(() => {
        setGithubHelperStatus('Snippet copied to clipboard! Paste into RUNNER_TARGETS_JSON.');
      }, (err) => {
        setGithubHelperStatus('Could not copy snippet: ' + err, true);
      });
    }

    document.getElementById('github-target').addEventListener('change', () => {
      refreshOwnerOptions();
    });

    document.getElementById('github-refresh-owners').addEventListener('click', () => {
      refreshOwnerOptions();
    });

    document.getElementById('github-refresh-repos').addEventListener('click', () => {
      refreshRepoOptions();
    });

    document.getElementById('github-copy-snippet').addEventListener('click', () => {
      createRunnerTargetSnippet();
    });

    document.getElementById('github-owner').addEventListener('input', () => {
      const owner = document.getElementById('github-owner').value.trim();
      document.getElementById('github-refresh-repos').disabled = owner === '';
    });

    document.getElementById('github-repo').addEventListener('input', () => {
      const owner = document.getElementById('github-owner').value.trim();
      const repo = document.getElementById('github-repo').value;
      setGithubHelperStatus(owner ? 'Selecting ' + owner + '/' + repo : 'Select owner/org first.');
    });

    refreshOwnerOptions().catch(() => {});

    async function launchRunner(targetId) {
      setBusy(true);
      statusNode.textContent = 'Launching ephemeral runner for target ' + targetId + '...';
      try {
        const payload = await callJson('/api/targets/' + targetId + '/launch', { method: 'POST' });
        statusNode.textContent = 'Runner ' + payload.runnerName + ' launched. Reloading...';
        window.setTimeout(() => window.location.reload(), 1800);
      } catch (error) {
        statusNode.textContent = 'Launch failed: ' + error.message;
        setBusy(false);
      }
    }

    async function removeRunner(containerId) {
      const confirmed = window.confirm('Remove this ephemeral runner stack and all of its Docker resources?');
      if (!confirmed) {
        return;
      }

      setBusy(true);
      statusNode.textContent = 'Removing runner stack ' + containerId.slice(0, 12) + '...';
      try {
        await callJson('/api/managed-runners/' + containerId + '/remove', { method: 'POST' });
        statusNode.textContent = 'Runner removed. Reloading...';
        window.setTimeout(() => window.location.reload(), 1200);
      } catch (error) {
        statusNode.textContent = 'Remove failed: ' + error.message;
        setBusy(false);
      }
    }

    async function showJobs(targetId, runId) {
      const panel = document.getElementById('jobs-panel-' + targetId);
      setBusy(true);
      statusNode.textContent = 'Loading jobs for run ' + runId + '...';
      try {
        const jobs = await callJson('/api/targets/' + targetId + '/runs/' + runId + '/jobs');
        if (!jobs.length) {
          panel.textContent = 'Run ' + runId + ' has no jobs.';
        } else {
          const rows = jobs.map((job) => {
            return '<tr>'
              + '<td><a href="' + job.html_url + '" target="_blank" rel="noreferrer">' + job.name + '</a></td>'
              + '<td>' + (job.status || '-') + '</td>'
              + '<td>' + (job.conclusion || '-') + '</td>'
              + '<td>' + (job.runner_name || '-') + '</td>'
              + '<td><button data-target-id="' + targetId + '" data-job-id="' + job.id + '" data-action="rerun-job">Rerun job</button></td>'
              + '</tr>';
          }).join('');
          panel.innerHTML = '<table><thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
          Array.from(panel.querySelectorAll('button[data-action=\"rerun-job\"]')).forEach((button) => {
            button.addEventListener('click', () => rerunJob(button.dataset.targetId, button.dataset.jobId));
          });
        }
        statusNode.textContent = 'Loaded jobs for run ' + runId + '.';
      } catch (error) {
        statusNode.textContent = 'Could not load jobs: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    async function forceCancel(targetId, runId) {
      const confirmed = window.confirm('This sends GitHub cancel and removes the matching ephemeral runner stack when possible. Continue?');
      if (!confirmed) {
        return;
      }

      setBusy(true);
      statusNode.textContent = 'Sending force cancel for run ' + runId + '...';
      try {
        await callJson('/api/targets/' + targetId + '/runs/' + runId + '/force-cancel', { method: 'POST' });
        statusNode.textContent = 'Force cancel sent. Reloading...';
        window.setTimeout(() => window.location.reload(), 1800);
      } catch (error) {
        statusNode.textContent = 'Force cancel failed: ' + error.message;
        setBusy(false);
      }
    }

    async function rerunRun(targetId, runId) {
      setBusy(true);
      statusNode.textContent = 'Requesting rerun for run ' + runId + '...';
      try {
        await callJson('/api/targets/' + targetId + '/runs/' + runId + '/rerun', { method: 'POST' });
        statusNode.textContent = 'Rerun requested for run ' + runId + '.';
      } catch (error) {
        statusNode.textContent = 'Rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    async function rerunFailed(targetId, runId) {
      setBusy(true);
      statusNode.textContent = 'Requesting failed-job rerun for run ' + runId + '...';
      try {
        await callJson('/api/targets/' + targetId + '/runs/' + runId + '/rerun-failed', { method: 'POST' });
        statusNode.textContent = 'Failed jobs rerun requested for run ' + runId + '.';
      } catch (error) {
        statusNode.textContent = 'Failed jobs rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    async function rerunJob(targetId, jobId) {
      setBusy(true);
      statusNode.textContent = 'Requesting rerun for job ' + jobId + '...';
      try {
        await callJson('/api/targets/' + targetId + '/jobs/' + jobId + '/rerun', { method: 'POST' });
        statusNode.textContent = 'Job rerun requested for job ' + jobId + '.';
      } catch (error) {
        statusNode.textContent = 'Job rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    Array.from(document.querySelectorAll('button[data-action]')).forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'launch-runner') {
          launchRunner(button.dataset.targetId);
        } else if (action === 'remove-runner') {
          removeRunner(button.dataset.containerId);
        } else if (action === 'show-jobs') {
          showJobs(button.dataset.targetId, button.dataset.runId);
        } else if (action === 'force-cancel') {
          forceCancel(button.dataset.targetId, button.dataset.runId);
        } else if (action === 'rerun-run') {
          rerunRun(button.dataset.targetId, button.dataset.runId);
        } else if (action === 'rerun-failed') {
          rerunFailed(button.dataset.targetId, button.dataset.runId);
        } else if (action === 'rerun-job') {
          rerunJob(button.dataset.targetId, button.dataset.jobId);
        }
      });
    });
  </script>
</body>
</html>`;
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function createServer(targets = loadTargets(), options = {}) {
  resetCleanupRuntime();
  const targetMap = getTargetMap(targets);
  const runFleetCleanupFn = options.runFleetCleanupFn || ((currentTargets) => runFleetCleanup(currentTargets, options));
  const getCleanupStatusFn = options.getCleanupStatusFn || snapshotCleanupStatus;

  return http.createServer(async (req, res) => {
    try {
      await readRequestBody(req);
      const requestUrl = new URL(req.url, 'http://localhost');
      const launchMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/launch$/);
      const runJobsMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/jobs$/);
      const forceCancelMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/force-cancel$/);
      const rerunRunMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/rerun$/);
      const rerunFailedMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/runs\/(\d+)\/rerun-failed$/);
      const rerunJobMatch = requestUrl.pathname.match(/^\/api\/targets\/([^/]+)\/jobs\/(\d+)\/rerun$/);
      const removeManagedMatch = requestUrl.pathname.match(/^\/api\/managed-runners\/([a-f0-9]{12,64})\/remove$/);

      if (launchMatch && req.method === 'POST') {
        const target = targetMap.get(launchMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${launchMatch[1]}` });
          return;
        }
        const result = await launchRunner(target);
        options.reconcileOnce?.().catch(() => {});
        sendJson(res, 200, result);
        return;
      }

      if (removeManagedMatch && req.method === 'POST') {
        const result = await removeManagedRunner(removeManagedMatch[1]);
        options.reconcileOnce?.().catch(() => {});
        sendJson(res, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/admin/cleanup/status' && req.method === 'GET') {
        sendJson(res, 200, getCleanupStatusFn());
        return;
      }

      if (requestUrl.pathname === '/api/admin/cleanup/fleet' && req.method === 'POST') {
        const result = await runFleetCleanupFn(targets, options);
        sendJson(res, 200, result);
        return;
      }

      if (runJobsMatch && req.method === 'GET') {
        const target = targetMap.get(runJobsMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${runJobsMatch[1]}` });
          return;
        }
        const jobs = await listRunJobs(target, runJobsMatch[2]);
        sendJson(res, 200, jobs);
        return;
      }

      if (forceCancelMatch && req.method === 'POST') {
        const target = targetMap.get(forceCancelMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${forceCancelMatch[1]}` });
          return;
        }
        const result = await forceCancelRun(target, forceCancelMatch[2]);
        options.reconcileOnce?.().catch(() => {});
        sendJson(res, 200, result);
        return;
      }

      if (rerunRunMatch && req.method === 'POST') {
        const target = targetMap.get(rerunRunMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${rerunRunMatch[1]}` });
          return;
        }
        const result = await rerunWorkflowRun(target, rerunRunMatch[2]);
        sendJson(res, 200, result);
        return;
      }

      if (rerunFailedMatch && req.method === 'POST') {
        const target = targetMap.get(rerunFailedMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${rerunFailedMatch[1]}` });
          return;
        }
        const result = await rerunFailedJobs(target, rerunFailedMatch[2]);
        sendJson(res, 200, result);
        return;
      }

      if (rerunJobMatch && req.method === 'POST') {
        const target = targetMap.get(rerunJobMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${rerunJobMatch[1]}` });
          return;
        }
        const result = await rerunJob(target, rerunJobMatch[2]);
        sendJson(res, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/github/owners' && req.method === 'GET') {
        const targetId = requestUrl.searchParams.get('targetId');
        if (!targetId) {
          sendJson(res, 400, { error: 'Missing targetId' });
          return;
        }
        const target = targetMap.get(targetId);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${targetId}` });
          return;
        }

        const q = String(requestUrl.searchParams.get('q') || '').trim();
        const ownerNames = await githubOwnerSuggestions(target.accessToken, q);
        sendJson(res, 200, ownerNames);
        return;
      }

      if (requestUrl.pathname === '/api/github/repos' && req.method === 'GET') {
        const targetId = requestUrl.searchParams.get('targetId');
        const owner = String(requestUrl.searchParams.get('owner') || '').trim();
        if (!targetId || !owner) {
          sendJson(res, 400, { error: 'Missing targetId or owner' });
          return;
        }
        const target = targetMap.get(targetId);
        if (!target) {
          sendJson(res, 404, { error: `Unknown target ${targetId}` });
          return;
        }
        const q = String(requestUrl.searchParams.get('q') || '').trim();
        const repos = await githubRepoSuggestions(target.accessToken, owner, q);
        sendJson(res, 200, repos);
        return;
      }

      const status = await getStatus(targets);
      if (requestUrl.pathname === '/api/status') {
        sendJson(res, 200, status);
        return;
      }

      sendHtml(res, 200, render(status));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

if (require.main === module) {
  const targets = loadTargets();
  const reconciler = createReconciler(targets);
  reconciler.start();
  startFleetCleanupLoop(targets);
  reconciler.reconcileOnce().catch((error) => {
    console.error('[runner-status] initial reconcile failed', error);
  });

  const server = createServer(targets, {
    reconcileOnce: reconciler.reconcileOnce,
  });
  server.listen(parseListenPort(process.env.STATUS_PORT), '0.0.0.0');
}

module.exports = {
  buildRunnerContainerSpec,
  createServer,
  createReconciler,
  desiredRunnerCountForTarget,
  groupManagedStacks,
  loadTargets,
  normalizeTarget,
  parseListenPort,
  parseRepoUrl,
  parseTargetsJson,
  shouldRemoveManagedStack,
  slugify,
  targetHasRepoFeed,
  filterAutocompleteValues,
  githubOwnerSuggestions,
  githubRepoSuggestions,
  githubCached,
  githubCacheKey,
  githubCacheGet,
  githubCacheSet,
};

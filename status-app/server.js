const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_PORT = 8080;
const DEFAULT_WORKDIR = '/tmp/github-runner';
const DEFAULT_DIND_IMAGE = 'docker:27-dind';
const DEFAULT_RUNNERS_PER_TARGET = Math.max(1, Number.parseInt(process.env.RUNNERS_PER_TARGET || '1', 10));
const DEFAULT_RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'myoung34/github-runner:latest';
const HEALTHCHECK_INTERVAL_MS = Number.parseInt(process.env.HEALTHCHECK_INTERVAL_MS || '15000', 10);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');

const MANAGED_LABEL = 'io.github-runner-fleet.managed';
const MANAGED_TARGET_LABEL = 'io.github-runner-fleet.target-id';
const MANAGED_RUNNER_LABEL = 'io.github-runner-fleet.runner-name';
const MANAGED_ROLE_LABEL = 'io.github-runner-fleet.role';
const MANAGED_STACK_LABEL = 'io.github-runner-fleet.stack-id';

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

/* ── Dashboard HTML Rendering ────────────────────────────────────────── */

function renderLabelList(labels) {
  if (!labels.length) return '<span class="muted">none</span>';
  return labels.map((l) => `<span class="pill">${escapeHtml(l)}</span>`).join('');
}

function renderTone(value, tone) {
  return `<span class="tone tone-${tone}">${escapeHtml(value)}</span>`;
}

function renderLocalRunnerRows(target) {
  if (!target.localRunners.length) return '<tr><td colspan="4">No runners configured.</td></tr>';
  return target.localRunners.map((r) => {
    const stateTone = r.state === 'running' ? 'ok' : 'danger';
    return `<tr><td><code>${escapeHtml(r.name)}</code></td><td>${renderTone(r.state, stateTone)}</td><td>${escapeHtml(r.status)}</td><td>${r.image ? escapeHtml(r.image) : '-'}</td></tr>`;
  }).join('');
}

function renderGithubRunnerRows(target) {
  if (!target.githubRunners.length) return '<tr><td colspan="5">No registered runners in GitHub.</td></tr>';
  return target.githubRunners.map((r) =>
    `<tr><td><code>${escapeHtml(r.name)}</code></td><td>${escapeHtml(r.status)}</td><td>${r.busy ? renderTone('busy', 'warn') : renderTone('idle', 'ok')}</td><td>${escapeHtml(r.os || '-')}</td><td>${renderLabelList(r.labels)}</td></tr>`
  ).join('');
}

function renderRunRows(target) {
  if (!targetHasRepoFeed(target)) return '<tr><td colspan="6">Configure a repo to see run history.</td></tr>';
  if (!target.latestRuns.length) return '<tr><td colspan="6">No recent runs.</td></tr>';
  return target.latestRuns.map((run) => {
    const actions = run.status !== 'completed'
      ? `<button class="danger" data-target-id="${escapeHtml(target.id)}" data-run-id="${run.id}" data-action="show-jobs">Jobs</button>`
      : `<button data-target-id="${escapeHtml(target.id)}" data-run-id="${run.id}" data-action="show-jobs">Jobs</button>
         <button data-target-id="${escapeHtml(target.id)}" data-run-id="${run.id}" data-action="rerun-run">Rerun</button>
         <button data-target-id="${escapeHtml(target.id)}" data-run-id="${run.id}" data-action="rerun-failed">Retry failed</button>`;
    return `<tr><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${run.id}</a></td><td>${escapeHtml(run.event)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.conclusion || '-')}</td><td>${escapeHtml(run.created_at)}</td><td><div class="actions">${actions}</div></td></tr>`;
  }).join('');
}

function renderTargetCard(target) {
  const repo = targetHasRepoFeed(target) ? target.repository : target.owner;
  const running = target.localRunners.filter((r) => r.state === 'running').length;
  const registered = target.githubRunners.length;
  const busy = target.githubRunners.filter((r) => r.busy).length;

  return `
    <section class="card target-card">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(target.name)}</h2>
          <div class="target-path">${escapeHtml(repo)}</div>
        </div>
        <div class="toolbar">
          <span class="scope-chip">${escapeHtml(target.scope)}</span>
          <button data-target-id="${escapeHtml(target.id)}" data-action="restart-target">Restart runners</button>
          <button class="danger" data-target-id="${escapeHtml(target.id)}" data-action="remove-target">Remove target</button>
        </div>
      </div>
      ${target.description ? `<p class="muted compact">${escapeHtml(target.description)}</p>` : ''}
      <div class="summary-strip">
        <div><span class="summary-label">Runners</span><strong>${running}/${target.runnersCount}</strong></div>
        <div><span class="summary-label">Registered</span><strong>${registered}</strong></div>
        <div><span class="summary-label">Busy</span><strong>${busy}</strong></div>
        <div><span class="summary-label">Labels</span><div>${renderLabelList(target.labels)}</div></div>
      </div>
      <div class="panel-grid">
        <section class="subcard">
          <h3>Local Runner Containers</h3>
          <table><thead><tr><th>Container</th><th>State</th><th>Status</th><th>Image</th></tr></thead>
          <tbody>${renderLocalRunnerRows(target)}</tbody></table>
        </section>
        <section class="subcard">
          <h3>Registered in GitHub</h3>
          <table><thead><tr><th>Name</th><th>Status</th><th>Busy</th><th>OS</th><th>Labels</th></tr></thead>
          <tbody>${renderGithubRunnerRows(target)}</tbody></table>
        </section>
      </div>
      <div class="panel-grid">
        <section class="subcard">
          <div class="section-head section-head-tight">
            <h3>Run Feed</h3>
            <span class="muted">${targetHasRepoFeed(target) ? escapeHtml(target.repository) : 'no repo configured'}</span>
          </div>
          <table><thead><tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th><th>Action</th></tr></thead>
          <tbody>${renderRunRows(target)}</tbody></table>
          <div id="jobs-panel-${escapeHtml(target.id)}" class="jobs-panel muted">Select a run to see jobs.</div>
        </section>
      </div>
    </section>`;
}

function render(status) {
  const totalRunning = status.targets.reduce((s, t) => s + t.localRunners.filter((r) => r.state === 'running').length, 0);
  const totalConfigured = status.targets.reduce((s, t) => s + t.runnersCount, 0);
  const totalRegistered = status.targets.reduce((s, t) => s + t.githubRunners.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>GitHub Runner Fleet</title>
  <style>
    :root { color-scheme: light; --bg: #f3f4ef; --surface: #ffffff; --surface-muted: #f7f7f3; --border: #d8d5cb; --text: #1f2320; --muted: #646a64; --accent: #285540; --accent-soft: #e6efe9; --warn: #9a6b16; --warn-soft: #fff2cf; --danger: #9c3d2d; --danger-soft: #fde7e3; }
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
    h1, h2, h3 { margin: 0; } h1 { font-size: 22px; } h2 { font-size: 20px; } h3 { font-size: 16px; }
    .muted { color: var(--muted); }
    .compact { margin: 8px 0 0; }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .section-head-tight { align-items: center; margin-bottom: 12px; }
    .toolbar, .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .target-path { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .summary-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 14px 0; }
    .summary-strip > div { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); }
    .summary-label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .summary-strip strong { font-size: 15px; }
    .panel-grid { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 14px; }
    .pill, .scope-chip, .tone { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 8px; font-size: 12px; border: 1px solid var(--border); background: var(--surface-muted); margin: 0 6px 6px 0; }
    .scope-chip { margin: 0; text-transform: lowercase; }
    .tone-ok { color: var(--accent); background: var(--accent-soft); border-color: #c8dccf; }
    .tone-warn { color: var(--warn); background: var(--warn-soft); border-color: #ecdba0; }
    .tone-danger { color: var(--danger); background: var(--danger-soft); border-color: #efc4bc; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid #ebe8de; font-size: 13px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; } td { padding-right: 12px; } tr:last-child td { border-bottom: 0; }
    code { font-family: "SFMono-Regular", Consolas, monospace; background: var(--surface-muted); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; }
    button { border: 1px solid #bfc3b6; background: #f5f5f1; color: var(--text); border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button:hover { background: #efefe9; } button:disabled { opacity: 0.6; cursor: wait; }
    button.danger { border-color: #d9b1a8; background: var(--danger-soft); color: var(--danger); }
    button.accent { border-color: #a3c5b0; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    .jobs-panel { margin-top: 14px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; background: var(--surface-muted); min-height: 48px; }
    #action-status { min-height: 20px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .form-field { display: flex; flex-direction: column; gap: 6px; }
    .form-field label { font-size: 13px; font-weight: 600; color: var(--muted); }
    .form-field input, .form-field select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; background: var(--surface); }
    .form-field.full { grid-column: 1 / -1; }
    @media (max-width: 1024px) { .overview, .summary-strip, .panel-grid, .form-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="overview">
      <section class="card page-head">
        <h1>GitHub Runner Fleet</h1>
        <p class="muted">Persistent self-hosted runners with isolated Docker-in-Docker daemons. Runners stay connected to GitHub; job containers are ephemeral.</p>
        <p class="muted">Updated <code>${escapeHtml(status.generatedAt)}</code></p>
        <p id="action-status" class="muted"></p>
      </section>
      <section class="metric"><span>Targets</span><strong>${status.targets.length}</strong></section>
      <section class="metric"><span>Runners</span><strong>${totalRunning}/${totalConfigured}</strong></section>
      <section class="metric"><span>Registered</span><strong>${totalRegistered}</strong></section>
    </section>

    <section class="card" id="add-target-card">
      <div class="section-head section-head-tight">
        <h2>Add Target</h2>
      </div>
      <form id="add-target-form">
        <div class="form-grid">
          <div class="form-field"><label>Name</label><input name="name" required placeholder="e.g. My Org Fleet"></div>
          <div class="form-field"><label>Scope</label><select name="scope"><option value="org" selected>Organization</option><option value="repo">Repository</option></select></div>
          <div class="form-field"><label>Owner / Org</label><input name="owner" required placeholder="e.g. my-org"></div>
          <div class="form-field"><label>Repository (for run feed)</label><input name="repo" placeholder="e.g. my-app"></div>
          <div class="form-field"><label>Labels</label><input name="labels" value="self-hosted,linux,x64" placeholder="comma-separated"></div>
          <div class="form-field"><label>Runners Count</label><input name="runnersCount" type="number" value="1" min="1" max="5"></div>
          <div class="form-field"><label>Runner Group</label><input name="runnerGroup" placeholder="Default"></div>
          <div class="form-field"><label>Description</label><input name="description" placeholder="optional"></div>
          <div class="form-field full" style="flex-direction:row;gap:12px;align-items:flex-end;">
            <button type="submit" class="accent">Add and Start Runners</button>
          </div>
        </div>
      </form>
    </section>

    ${status.targets.map(renderTargetCard).join('')}
  </main>
  <script>
    const statusNode = document.getElementById('action-status');
    function setBusy(d) { document.querySelectorAll('button[data-action],button[type=submit]').forEach((b) => { b.disabled = d; }); }

    async function callJson(url, options = {}) {
      const r = await fetch(url, options);
      const p = await r.json();
      if (!r.ok) throw new Error(p.error || 'Unknown error');
      return p;
    }

    document.getElementById('add-target-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      setBusy(true);
      statusNode.textContent = 'Adding target...';
      try {
        const fd = new FormData(e.target);
        const body = {
          name: fd.get('name'), scope: fd.get('scope'), owner: fd.get('owner'),
          repo: fd.get('repo'), labels: fd.get('labels'), runnersCount: Number(fd.get('runnersCount')),
          runnerGroup: fd.get('runnerGroup'), description: fd.get('description'),
        };
        await callJson('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        statusNode.textContent = 'Target added. Reloading...';
        setTimeout(() => location.reload(), 2000);
      } catch (err) { statusNode.textContent = 'Failed: ' + err.message; setBusy(false); }
    });

    async function restartTarget(targetId) {
      setBusy(true); statusNode.textContent = 'Restarting runners for ' + targetId + '...';
      try {
        await callJson('/api/targets/' + targetId + '/restart', { method: 'POST' });
        statusNode.textContent = 'Restarting... reloading in 5s.';
        setTimeout(() => location.reload(), 5000);
      } catch (err) { statusNode.textContent = 'Failed: ' + err.message; setBusy(false); }
    }

    async function removeTarget(targetId) {
      if (!confirm('Remove target ' + targetId + ' and stop its runners?')) return;
      setBusy(true); statusNode.textContent = 'Removing target...';
      try {
        await callJson('/api/targets/' + targetId, { method: 'DELETE' });
        statusNode.textContent = 'Target removed. Reloading...';
        setTimeout(() => location.reload(), 2000);
      } catch (err) { statusNode.textContent = 'Failed: ' + err.message; setBusy(false); }
    }

    async function showJobs(targetId, runId) {
      const panel = document.getElementById('jobs-panel-' + targetId);
      setBusy(true); statusNode.textContent = 'Loading jobs...';
      try {
        const jobs = await callJson('/api/targets/' + targetId + '/runs/' + runId + '/jobs');
        panel.innerHTML = jobs.length ? '<table><thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th><th>Action</th></tr></thead><tbody>' + jobs.map((j) => '<tr><td><a href="' + j.html_url + '" target="_blank">' + j.name + '</a></td><td>' + j.status + '</td><td>' + (j.conclusion||'-') + '</td><td>' + (j.runner_name||'-') + '</td><td><button data-target-id="' + targetId + '" data-job-id="' + j.id + '" data-action="rerun-job">Rerun</button></td></tr>').join('') + '</tbody></table>' : 'No jobs found.';
        statusNode.textContent = '';
        panel.querySelectorAll('button[data-action]').forEach(bindAction);
      } catch (err) { statusNode.textContent = 'Failed: ' + err.message; } finally { setBusy(false); }
    }

    async function rerunRun(targetId, runId) { setBusy(true); try { await callJson('/api/targets/' + targetId + '/runs/' + runId + '/rerun', { method: 'POST' }); statusNode.textContent = 'Rerun requested.'; } catch (e) { statusNode.textContent = 'Failed: ' + e.message; } finally { setBusy(false); } }
    async function rerunFailed(targetId, runId) { setBusy(true); try { await callJson('/api/targets/' + targetId + '/runs/' + runId + '/rerun-failed', { method: 'POST' }); statusNode.textContent = 'Retry failed requested.'; } catch (e) { statusNode.textContent = 'Failed: ' + e.message; } finally { setBusy(false); } }
    async function rerunJob(targetId, jobId) { setBusy(true); try { await callJson('/api/targets/' + targetId + '/jobs/' + jobId + '/rerun', { method: 'POST' }); statusNode.textContent = 'Job rerun requested.'; } catch (e) { statusNode.textContent = 'Failed: ' + e.message; } finally { setBusy(false); } }

    function bindAction(button) {
      button.addEventListener('click', () => {
        const a = button.dataset.action;
        if (a === 'restart-target') restartTarget(button.dataset.targetId);
        else if (a === 'remove-target') removeTarget(button.dataset.targetId);
        else if (a === 'show-jobs') showJobs(button.dataset.targetId, button.dataset.runId);
        else if (a === 'rerun-run') rerunRun(button.dataset.targetId, button.dataset.runId);
        else if (a === 'rerun-failed') rerunFailed(button.dataset.targetId, button.dataset.runId);
        else if (a === 'rerun-job') rerunJob(button.dataset.targetId, button.dataset.jobId);
      });
    }
    document.querySelectorAll('button[data-action]').forEach(bindAction);
  </script>
</body>
</html>`;
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

      /* ── Dashboard / Status ── */
      if (url.pathname === '/api/status') {
        sendJson(res, 200, await getStatus(targets));
        return;
      }

      const status = await getStatus(targets);
      sendHtml(res, 200, render(status));
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
  slugify, targetHasRepoFeed, loadPersistedTargets, saveTargets, ensureRunnersForTarget,
};

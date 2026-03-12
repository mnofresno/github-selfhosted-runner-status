const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_PORT = Number.parseInt(process.env.STATUS_PORT || '8080', 10);
const DEFAULT_WORKDIR = '/tmp/github-runner';
const MANAGED_LABEL = 'io.github-selfhosted.managed';
const MANAGED_TARGET_LABEL = 'io.github-selfhosted.target-id';
const MANAGED_RUNNER_LABEL = 'io.github-selfhosted.runner-name';
const STATIC_RUNNER_LABEL = 'com.docker.compose.service=runner';

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
  const name = input.name || id;

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
    repoUrl: scope === 'repo' ? `https://github.com/${owner}/${repo}` : '',
    accessToken: token,
    labels,
    runnerImage: image,
    runnerWorkdir: workdir,
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

function getManagedContainerFilters(extraLabels = []) {
  return encodeURIComponent(JSON.stringify({
    label: [MANAGED_LABEL, ...extraLabels],
  }));
}

async function listManagedRunnerContainers(targetId) {
  const labels = targetId ? [`${MANAGED_TARGET_LABEL}=${targetId}`] : [];
  const response = await docker(`/containers/json?all=1&filters=${getManagedContainerFilters(labels)}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }

  return response.body.map((container) => ({
    id: container.Id,
    shortId: container.Id.slice(0, 12),
    name: (container.Names?.[0] || '').replace(/^\//, ''),
    image: container.Image,
    state: container.State,
    status: container.Status,
    created: container.Created,
    targetId: container.Labels?.[MANAGED_TARGET_LABEL] || '',
    runnerName: container.Labels?.[MANAGED_RUNNER_LABEL] || '',
  }));
}

async function getStaticRunnerContainer() {
  const filters = encodeURIComponent(JSON.stringify({
    label: [
      `com.docker.compose.project=${process.env.COMPOSE_PROJECT_NAME || 'github-selfhosted'}`,
      STATIC_RUNNER_LABEL,
    ],
  }));
  const response = await docker(`/containers/json?all=1&filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }
  return response.body[0] || null;
}

function formatRunnerName(target) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${target.runnerNamePrefix}-${stamp}`;
}

function buildRunnerContainerSpec(target, runnerName) {
  const volumeName = `ghrunner-${target.id}-${stampFragment()}`;
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
    volumeName,
    body: {
      Image: target.runnerImage,
      Env: env,
      Labels: {
        [MANAGED_LABEL]: 'true',
        [MANAGED_TARGET_LABEL]: target.id,
        [MANAGED_RUNNER_LABEL]: runnerName,
      },
      HostConfig: {
        Binds: [
          '/var/run/docker.sock:/var/run/docker.sock',
          `${volumeName}:${target.runnerWorkdir}`,
        ],
      },
    },
  };
}

function stampFragment() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createVolume(name) {
  const response = await docker('/volumes/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Name: name,
      Labels: { [MANAGED_LABEL]: 'true' },
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

async function launchRunner(target) {
  const runnerName = formatRunnerName(target);
  const containerName = `runner-${target.id}-${stampFragment()}`.slice(0, 63);
  const spec = buildRunnerContainerSpec(target, runnerName);

  await createVolume(spec.volumeName);

  const createResponse = await docker(`/containers/create?name=${encodeURIComponent(containerName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec.body),
  });

  if (createResponse.statusCode < 200 || createResponse.statusCode >= 300) {
    await removeVolume(spec.volumeName).catch(() => {});
    throw new Error(`Container create failed with status ${createResponse.statusCode}`);
  }

  const containerId = createResponse.body.Id;
  const startResponse = await docker(`/containers/${containerId}/start`, { method: 'POST' });
  if (![204, 304].includes(startResponse.statusCode)) {
    await docker(`/containers/${containerId}?force=1`, { method: 'DELETE' }).catch(() => {});
    await removeVolume(spec.volumeName).catch(() => {});
    throw new Error(`Container start failed with status ${startResponse.statusCode}`);
  }

  return {
    targetId: target.id,
    runnerName,
    containerId,
    containerName,
    volumeName: spec.volumeName,
  };
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
  if (target.scope !== 'repo') {
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
  if (target.scope !== 'repo') {
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

async function killMatchingManagedRunner(runnerNames) {
  if (!runnerNames.length) {
    return [];
  }

  const filters = encodeURIComponent(JSON.stringify({
    label: [MANAGED_LABEL],
  }));
  const response = await docker(`/containers/json?all=1&filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }

  const targets = response.body.filter((container) => runnerNames.includes(container.Labels?.[MANAGED_RUNNER_LABEL]));
  const results = [];

  for (const container of targets) {
    const killResponse = await docker(`/containers/${container.Id}/kill?signal=SIGKILL`, { method: 'POST' });
    if (![204, 304, 409].includes(killResponse.statusCode)) {
      throw new Error(`Runner kill failed with status ${killResponse.statusCode}`);
    }
    results.push({
      containerId: container.Id,
      containerName: container.Names?.[0] || '',
      statusCode: killResponse.statusCode,
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
  if (killedManaged.length) {
    result.runnerKill = killedManaged;
    return result;
  }

  const container = await getStaticRunnerContainer();
  if (!container) {
    result.runnerKill = [{ status: 'runner-not-found' }];
    return result;
  }

  const killResponse = await docker(`/containers/${container.Id}/kill?signal=SIGKILL`, { method: 'POST' });
  if (![204, 304, 409].includes(killResponse.statusCode)) {
    throw new Error(`Runner kill failed with status ${killResponse.statusCode}`);
  }

  result.runnerKill = [{
    containerId: container.Id,
    containerName: container.Names?.[0] || '',
    statusCode: killResponse.statusCode,
  }];
  return result;
}

async function getTargetStatus(target) {
  const [githubRunners, latestRuns, localRunners] = await Promise.all([
    githubRunnersForTarget(target),
    latestRunsForTarget(target),
    listManagedRunnerContainers(target.id),
  ]);

  const activeRun = latestRuns.find((run) => run.status !== 'completed') || null;
  const activeJobs = activeRun ? await listRunJobs(target, activeRun.id) : [];

  return {
    id: target.id,
    name: target.name,
    scope: target.scope,
    owner: target.owner,
    repo: target.repo,
    repository: target.scope === 'repo' ? `${target.owner}/${target.repo}` : target.owner,
    description: target.description,
    labels: target.labels,
    localRunners,
    githubRunners: githubRunners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      status: runner.status,
      busy: runner.busy,
      labels: (runner.labels || []).map((label) => label.name),
      os: runner.os,
    })),
    activeRun,
    activeJobs,
    latestRuns,
  };
}

async function getStatus(targets) {
  const targetStatuses = [];
  for (const target of targets) {
    targetStatuses.push(await getTargetStatus(target));
  }

  const managedRunners = await listManagedRunnerContainers();
  return {
    generatedAt: new Date().toISOString(),
    targets: targetStatuses,
    managedRunners,
  };
}

function renderManagedRunnerRows(target) {
  if (!target.localRunners.length) {
    return '<tr><td colspan="6">No launched ephemeral runners for this target.</td></tr>';
  }

  return target.localRunners.map((runner) => {
    const removeButton = `<button class="danger" data-container-id="${escapeHtml(runner.id)}" data-action="remove-runner">Remove</button>`;
    return `<tr><td><code>${escapeHtml(runner.runnerName || runner.name)}</code></td><td>${escapeHtml(runner.state)}</td><td>${escapeHtml(runner.status)}</td><td>${escapeHtml(runner.image)}</td><td>${escapeHtml(new Date(runner.created * 1000).toISOString())}</td><td>${removeButton}</td></tr>`;
  }).join('');
}

function renderGithubRunnerRows(target) {
  if (!target.githubRunners.length) {
    return '<tr><td colspan="5">No registered runners found in GitHub for this target.</td></tr>';
  }

  return target.githubRunners.map((runner) => (
    `<tr><td><code>${escapeHtml(runner.name)}</code></td><td>${escapeHtml(runner.status)}</td><td>${runner.busy ? '<span class="warn">busy</span>' : '<span class="ok">idle</span>'}</td><td>${escapeHtml(runner.os || '-')}</td><td>${runner.labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join('')}</td></tr>`
  )).join('');
}

function renderRunRows(target) {
  if (target.scope !== 'repo') {
    return '<tr><td colspan="6">Org-scoped runners do not expose a unified workflow run feed. Use repo-scoped targets when you need run-level controls.</td></tr>';
  }
  if (!target.latestRuns.length) {
    return '<tr><td colspan="6">No recent runs.</td></tr>';
  }

  return target.latestRuns.map((run) => {
    const actions = [];
    if (run.status !== 'completed') {
      actions.push(`<button class="danger" data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="force-cancel">Force cancel</button>`);
    } else {
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="show-jobs">Jobs</button>`);
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="rerun-run">Rerun all</button>`);
      actions.push(`<button data-target-id="${escapeHtml(target.id)}" data-run-id="${escapeHtml(run.id)}" data-action="rerun-failed">Rerun failed</button>`);
    }
    return `<tr><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${run.id}</a></td><td>${escapeHtml(run.event)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.conclusion || '-')}</td><td>${escapeHtml(run.created_at)}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
  }).join('');
}

function renderTargetCard(target) {
  const scopedCopy = target.scope === 'repo'
    ? `Repository target for ${escapeHtml(target.repository)}`
    : `Organization target for ${escapeHtml(target.owner)}`;

  return `
    <section class="card">
      <div class="stack">
        <div>
          <h2>${escapeHtml(target.name)}</h2>
          <p class="muted">${scopedCopy}</p>
        </div>
        <button data-target-id="${escapeHtml(target.id)}" data-action="launch-runner">Launch ephemeral runner</button>
      </div>
      ${target.description ? `<p>${escapeHtml(target.description)}</p>` : ''}
      <p>Scope: <strong>${escapeHtml(target.scope)}</strong></p>
      <p>Labels: ${target.labels.length ? target.labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join('') : '<span class="muted">none</span>'}</p>
      <div class="panel-grid">
        <div>
          <h3>Managed Ephemeral Runners</h3>
          <table>
            <thead><tr><th>Runner</th><th>State</th><th>Status</th><th>Image</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>${renderManagedRunnerRows(target)}</tbody>
          </table>
        </div>
        <div>
          <h3>GitHub Registered Runners</h3>
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Busy</th><th>OS</th><th>Labels</th></tr></thead>
            <tbody>${renderGithubRunnerRows(target)}</tbody>
          </table>
        </div>
      </div>
      <div class="panel-grid">
        <div>
          <h3>Latest Runs</h3>
          <table>
            <thead><tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>${renderRunRows(target)}</tbody>
          </table>
        </div>
        <div>
          <h3>Active Jobs</h3>
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th></tr></thead>
            <tbody>${target.activeJobs.length
              ? target.activeJobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.conclusion || '-')}</td><td>${escapeHtml(job.runner_name || '-')}</td></tr>`).join('')
              : '<tr><td colspan="4">No active jobs</td></tr>'}</tbody>
          </table>
          <div id="jobs-panel-${escapeHtml(target.id)}" class="muted" style="margin-top: 12px;">No completed run selected.</div>
        </div>
      </div>
    </section>
  `;
}

function render(status) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="20">
  <title>GitHub Runner Fleet</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #f4f6f8; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
    .card { background: #171a21; border: 1px solid #2a3140; border-radius: 14px; padding: 18px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22); }
    .stack { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .panel-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin-top: 16px; }
    .muted { color: #9ca3af; }
    .ok { color: #86efac; }
    .warn { color: #fbbf24; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; margin: 0 6px 6px 0; border-radius: 999px; background: #1f2530; border: 1px solid #313a49; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #2a3140; font-size: 14px; vertical-align: top; }
    code { background: #11161d; border: 1px solid #2a3140; border-radius: 6px; padding: 2px 6px; }
    button { border: 1px solid #42506a; background: #202938; color: #f9fafb; border-radius: 10px; padding: 9px 13px; font: inherit; cursor: pointer; }
    button:hover { background: #273244; }
    button:disabled { opacity: 0.6; cursor: wait; }
    button.danger { border-color: #7f1d1d; background: #3f1619; color: #fecaca; }
    a { color: #d7e3ff; text-decoration: none; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    #action-status { min-height: 22px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="stack">
        <div>
          <h1>GitHub Self-Hosted Runner Fleet</h1>
          <p class="muted">Generated at <code>${escapeHtml(status.generatedAt)}</code></p>
        </div>
        <div class="muted">Recommendation: use repo-scoped targets by default. Reserve org-scoped runners for shared trusted repos inside the same organization.</div>
      </div>
      <p id="action-status" class="muted">The UI can launch multiple ephemeral runners. Each launched runner is isolated by target and removed independently.</p>
    </section>
    ${status.targets.map((target) => renderTargetCard(target)).join('')}
    <section class="card">
      <h2>Fleet Summary</h2>
      <p class="muted">All app-managed runner containers currently visible via Docker.</p>
      <table>
        <thead><tr><th>Container</th><th>Target</th><th>Runner</th><th>State</th><th>Status</th></tr></thead>
        <tbody>${status.managedRunners.length
          ? status.managedRunners.map((runner) => `<tr><td><code>${escapeHtml(runner.name)}</code></td><td>${escapeHtml(runner.targetId)}</td><td>${escapeHtml(runner.runnerName)}</td><td>${escapeHtml(runner.state)}</td><td>${escapeHtml(runner.status)}</td></tr>`).join('')
          : '<tr><td colspan="5">No managed runners currently exist.</td></tr>'}</tbody>
      </table>
    </section>
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
      const confirmed = window.confirm('Remove this managed runner container and its work volume?');
      if (!confirmed) {
        return;
      }

      setBusy(true);
      statusNode.textContent = 'Removing runner container ' + containerId.slice(0, 12) + '...';
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
      const confirmed = window.confirm('This sends GitHub cancel and kills the matching local runner container when possible. Continue?');
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

function createServer(targets = loadTargets()) {
  const targetMap = getTargetMap(targets);

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
        sendJson(res, 200, result);
        return;
      }

      if (removeManagedMatch && req.method === 'POST') {
        const result = await removeManagedRunner(removeManagedMatch[1]);
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
  const server = createServer();
  server.listen(DEFAULT_PORT, '0.0.0.0');
}

module.exports = {
  buildRunnerContainerSpec,
  createServer,
  loadTargets,
  normalizeTarget,
  parseRepoUrl,
  parseTargetsJson,
  slugify,
};

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { shouldRunCleanup, pruneDanglingResources } = require('./cleanup');

const repoUrl = process.env.REPO_URL || '';
const token = process.env.ACCESS_TOKEN || '';
const runnerName = process.env.RUNNER_NAME || '';
const composeProjectName = process.env.COMPOSE_PROJECT_NAME || 'github-selfhosted';
const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
const owner = match?.[1] || '';
const repo = (match?.[2] || '').replace(/\.git$/i, '');
const cleanupState = {
  running: false,
  lastRunAt: 0,
  lastResult: null,
};

function collectJson(res, resolve, reject) {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const body = data ? JSON.parse(data) : {};
    resolve({ statusCode: res.statusCode, body });
  });
  res.on('error', reject);
}

function github(path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'runner-status',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      collectJson(res, ({ statusCode, body }) => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`GitHub API ${statusCode}: ${JSON.stringify(body).slice(0, 200)}`));
          return;
        }
        resolve(body);
      }, reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function githubRaw(path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'runner-status',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => collectJson(res, resolve, reject));
    req.on('error', reject);
    req.end();
  });
}

function docker(path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      path,
      method,
    }, (res) => collectJson(res, resolve, reject));
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

async function getStatus() {
  const [runners, runs] = await Promise.all([
    github(`/repos/${owner}/${repo}/actions/runners`),
    github(`/repos/${owner}/${repo}/actions/runs?per_page=8`),
  ]);

  const runner = (runners.runners || []).find((item) => item.name === runnerName) || null;
  const latestRuns = (runs.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    created_at: run.created_at,
  }));

  let activeJobs = [];
  const activeRun = latestRuns.find((run) => run.status !== 'completed');
  if (activeRun) {
    const jobs = await github(`/repos/${owner}/${repo}/actions/runs/${activeRun.id}/jobs`);
    activeJobs = (jobs.jobs || []).map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      runner_name: job.runner_name,
    }));
  }

  return {
    repository: `${owner}/${repo}`,
    runner: runner ? {
      name: runner.name,
      status: runner.status,
      busy: runner.busy,
      labels: (runner.labels || []).map((label) => label.name),
    } : null,
    activeRun,
    activeJobs,
    latestRuns,
    cleanup: cleanupState.lastResult,
    generatedAt: new Date().toISOString(),
  };
}

async function reconcileDanglingResources(status) {
  const decision = shouldRunCleanup({ status, cleanupState });
  if (!decision.ok) {
    return;
  }

  cleanupState.running = true;
  try {
    const result = await pruneDanglingResources(docker);
    cleanupState.lastRunAt = Date.now();
    cleanupState.lastResult = {
      status: 'completed',
      reason: decision.reason,
      completedAt: new Date(cleanupState.lastRunAt).toISOString(),
      result,
    };
  } catch (error) {
    cleanupState.lastRunAt = Date.now();
    cleanupState.lastResult = {
      status: 'failed',
      reason: decision.reason,
      completedAt: new Date(cleanupState.lastRunAt).toISOString(),
      error: error.message,
    };
  } finally {
    cleanupState.running = false;
  }
}

async function getRunnerContainer() {
  const filters = encodeURIComponent(JSON.stringify({
    label: [
      `com.docker.compose.project=${composeProjectName}`,
      'com.docker.compose.service=runner',
    ],
  }));
  const response = await docker(`/containers/json?all=1&filters=${filters}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Docker API ${response.statusCode}`);
  }
  return response.body[0] || null;
}

async function listRunJobs(runId) {
  const jobs = await github(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
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

async function rerunWorkflowRun(runId) {
  const response = await githubRaw(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Run rerun failed with status ${response.statusCode}`);
  }
  return { runId, scope: 'run', statusCode: response.statusCode };
}

async function rerunFailedJobs(runId) {
  const response = await githubRaw(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Failed-jobs rerun failed with status ${response.statusCode}`);
  }
  return { runId, scope: 'failed-jobs', statusCode: response.statusCode };
}

async function rerunJob(jobId) {
  const response = await githubRaw(`/repos/${owner}/${repo}/actions/jobs/${jobId}/rerun`, { method: 'POST' });
  if (![201, 202].includes(response.statusCode)) {
    throw new Error(`Job rerun failed with status ${response.statusCode}`);
  }
  return { jobId, scope: 'job', statusCode: response.statusCode };
}

async function forceCancelRun(runId) {
  const result = {
    runId,
    github: null,
    runnerKill: null,
  };

  const forceCancel = await githubRaw(`/repos/${owner}/${repo}/actions/runs/${runId}/force-cancel`, { method: 'POST' });
  if ([202, 204, 409].includes(forceCancel.statusCode)) {
    result.github = {
      endpoint: 'force-cancel',
      statusCode: forceCancel.statusCode,
    };
  } else if (forceCancel.statusCode === 404 || forceCancel.statusCode === 422) {
    const fallback = await githubRaw(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' });
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

  const container = await getRunnerContainer();
  if (!container) {
    result.runnerKill = {
      status: 'runner-not-found',
    };
    return result;
  }

  const killResponse = await docker(`/containers/${container.Id}/kill?signal=SIGKILL`, { method: 'POST' });
  if (![204, 304, 409].includes(killResponse.statusCode)) {
    throw new Error(`Runner kill failed with status ${killResponse.statusCode}`);
  }
  result.runnerKill = {
    status: 'sent',
    containerId: container.Id,
    containerName: container.Names?.[0] || '',
    statusCode: killResponse.statusCode,
  };
  return result;
}

function render(status) {
  const runner = status.runner;
  const activeRun = status.activeRun;
  const cleanup = status.cleanup;
  const jobs = status.activeJobs.length
    ? status.activeJobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.conclusion || '-')}</td><td>${escapeHtml(job.runner_name || '-')}</td></tr>`).join('')
    : '<tr><td colspan="4">No active jobs</td></tr>';
  const runs = status.latestRuns.map((run) => {
    const actions = [];
    if (run.status !== 'completed') {
      actions.push(`<button class="danger" data-run-id="${escapeHtml(run.id)}" data-action="force-cancel">Force cancel</button>`);
    } else {
      actions.push(`<button data-run-id="${escapeHtml(run.id)}" data-action="show-jobs">Jobs</button>`);
      actions.push(`<button data-run-id="${escapeHtml(run.id)}" data-action="rerun-run">Rerun all</button>`);
      actions.push(`<button data-run-id="${escapeHtml(run.id)}" data-action="rerun-failed">Rerun failed</button>`);
    }
    return `<tr><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${run.id}</a></td><td>${escapeHtml(run.event)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.conclusion || '-')}</td><td>${escapeHtml(run.created_at)}</td><td><div class="actions">${actions.join('')}</div></td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>GitHub Runner Status</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 24px; font-family: ui-sans-serif, system-ui, sans-serif; background: #111315; color: #f3f4f6; }
    .grid { display: grid; gap: 12px; max-width: 1120px; margin: 0 auto; }
    .card { background: #17191c; border: 1px solid #2a2f36; border-radius: 10px; padding: 18px; }
    .stack { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 8px; font-size: 12px; background: #20242a; border: 1px solid #2d333b; margin-right: 6px; margin-bottom: 6px; }
    .ok { color: #86efac; }
    .warn { color: #fbbf24; }
    .bad { color: #f87171; }
    .muted { color: #9ca3af; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #2a2f36; font-size: 14px; vertical-align: top; }
    a { color: #d1d5db; text-decoration: none; }
    button { border: 1px solid #4b5563; background: #23272d; color: #f9fafb; border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }
    button:hover { background: #2b3138; }
    button:disabled { opacity: 0.6; cursor: wait; }
    button.danger { border-color: #7f1d1d; background: #3a1414; color: #fecaca; }
    button.danger:hover { background: #4a1717; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    code { background: #101214; border: 1px solid #2a2f36; border-radius: 6px; padding: 2px 6px; }
    #action-status { min-height: 20px; }
  </style>
</head>
<body>
  <div class="grid">
    <div class="card">
      <div class="stack">
        <h1>GitHub Self-Hosted Runner</h1>
        ${activeRun ? `<button class="danger" data-run-id="${escapeHtml(activeRun.id)}" data-action="force-cancel">Force cancel active run</button>` : ''}
      </div>
      <p>Repository: <strong>${escapeHtml(status.repository)}</strong></p>
      <p>Generated: <code>${escapeHtml(status.generatedAt)}</code></p>
      <p id="action-status" class="muted">${activeRun ? `Active run ${escapeHtml(activeRun.id)} is eligible for force cancel.` : 'No active run detected.'}</p>
      ${runner ? `
        <p>Runner: <strong>${escapeHtml(runner.name)}</strong></p>
        <p>Status: <strong class="${runner.busy ? 'warn' : 'ok'}">${escapeHtml(runner.status)}</strong> | Busy: <strong class="${runner.busy ? 'warn' : 'ok'}">${runner.busy}</strong></p>
        <div>${runner.labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join('')}</div>
      ` : '<p class="bad">Runner not found in GitHub API.</p>'}
      ${cleanup ? `<p>Cleanup: <strong>${escapeHtml(cleanup.status)}</strong> at <code>${escapeHtml(cleanup.completedAt || '-')}</code></p>` : '<p>Cleanup: <strong>pending</strong></p>'}
    </div>
    <div class="card">
      <h2>Active Jobs</h2>
      <p class="muted">GitHub exposes cancel at run level. Specific jobs can be re-run, not cleanly canceled on their own.</p>
      <table>
        <thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th></tr></thead>
        <tbody>${jobs}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Latest Runs</h2>
      <table>
        <thead><tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th><th>Action</th></tr></thead>
        <tbody>${runs}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Selected Run Jobs</h2>
      <p class="muted">Choose a completed run to inspect its jobs and re-run individual parts.</p>
      <div id="jobs-panel" class="muted">No run selected.</div>
    </div>
  </div>
  <script>
    const statusNode = document.getElementById('action-status');
    const jobsPanel = document.getElementById('jobs-panel');
    const buttons = Array.from(document.querySelectorAll('button[data-run-id]'));

    function setBusy(disabled) {
      buttons.forEach((item) => { item.disabled = disabled; });
    }

    async function callJson(url) {
      const response = await fetch(url);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Unknown error');
      }
      return payload;
    }

    async function forceCancel(runId) {
      const confirmed = window.confirm('This sends GitHub force-cancel and SIGKILL to the runner container. Continue?');
      if (!confirmed) {
        return;
      }

      setBusy(true);
      statusNode.textContent = 'Sending force cancel...';

      try {
        await callJson('/api/runs/' + runId + '/force-cancel');
        statusNode.textContent = 'Force cancel sent for run ' + runId + '. Reloading...';
        window.setTimeout(() => window.location.reload(), 1800);
      } catch (error) {
        statusNode.textContent = 'Force cancel failed: ' + error.message;
        setBusy(false);
      }
    }

    function renderJobs(runId, jobs) {
      if (!jobs.length) {
        jobsPanel.innerHTML = '<p class="muted">Run ' + runId + ' has no jobs.</p>';
        return;
      }

      const rows = jobs.map((job) => {
        return '<tr>'
          + '<td><a href="' + job.html_url + '" target="_blank" rel="noreferrer">' + job.name + '</a></td>'
          + '<td>' + (job.status || '-') + '</td>'
          + '<td>' + (job.conclusion || '-') + '</td>'
          + '<td>' + (job.runner_name || '-') + '</td>'
          + '<td><button data-job-id="' + job.id + '" data-action="rerun-job">Rerun job</button></td>'
          + '</tr>';
      }).join('');

      jobsPanel.innerHTML = '<table><thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
      Array.from(jobsPanel.querySelectorAll('button[data-job-id]')).forEach((button) => {
        button.addEventListener('click', () => rerunJob(button.dataset.jobId));
      });
    }

    async function showJobs(runId) {
      jobsPanel.textContent = 'Loading jobs for run ' + runId + '...';
      try {
        const jobs = await callJson('/api/runs/' + runId + '/jobs');
        renderJobs(runId, jobs);
      } catch (error) {
        jobsPanel.textContent = 'Could not load jobs: ' + error.message;
      }
    }

    async function rerunRun(runId) {
      setBusy(true);
      statusNode.textContent = 'Sending rerun for run ' + runId + '...';
      try {
        await callJson('/api/runs/' + runId + '/rerun');
        statusNode.textContent = 'Rerun requested for run ' + runId + '.';
      } catch (error) {
        statusNode.textContent = 'Rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    async function rerunFailed(runId) {
      setBusy(true);
      statusNode.textContent = 'Sending rerun for failed jobs in run ' + runId + '...';
      try {
        await callJson('/api/runs/' + runId + '/rerun-failed');
        statusNode.textContent = 'Failed jobs rerun requested for run ' + runId + '.';
      } catch (error) {
        statusNode.textContent = 'Failed jobs rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    async function rerunJob(jobId) {
      setBusy(true);
      statusNode.textContent = 'Sending rerun for job ' + jobId + '...';
      try {
        await callJson('/api/jobs/' + jobId + '/rerun');
        statusNode.textContent = 'Job rerun requested for job ' + jobId + '.';
      } catch (error) {
        statusNode.textContent = 'Job rerun failed: ' + error.message;
      } finally {
        setBusy(false);
      }
    }

    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'force-cancel') {
          forceCancel(button.dataset.runId);
        } else if (action === 'show-jobs') {
          showJobs(button.dataset.runId);
        } else if (action === 'rerun-run') {
          rerunRun(button.dataset.runId);
        } else if (action === 'rerun-failed') {
          rerunFailed(button.dataset.runId);
        }
      });
    });
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const forceCancelMatch = requestUrl.pathname.match(/^\/api\/runs\/(\d+)\/force-cancel$/);
    const runJobsMatch = requestUrl.pathname.match(/^\/api\/runs\/(\d+)\/jobs$/);
    const rerunRunMatch = requestUrl.pathname.match(/^\/api\/runs\/(\d+)\/rerun$/);
    const rerunFailedMatch = requestUrl.pathname.match(/^\/api\/runs\/(\d+)\/rerun-failed$/);
    const rerunJobMatch = requestUrl.pathname.match(/^\/api\/jobs\/(\d+)\/rerun$/);

    if (forceCancelMatch) {
      const result = await forceCancelRun(forceCancelMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }

    if (runJobsMatch) {
      const jobs = await listRunJobs(runJobsMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(jobs));
      return;
    }

    if (rerunRunMatch) {
      const result = await rerunWorkflowRun(rerunRunMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }

    if (rerunFailedMatch) {
      const result = await rerunFailedJobs(rerunFailedMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }

    if (rerunJobMatch) {
      const result = await rerunJob(rerunJobMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
      return;
    }

    const status = await getStatus();
    void reconcileDanglingResources(status);
    if (requestUrl.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(render(status));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(8080, '0.0.0.0');

const http = require('http');
const https = require('https');

const repoUrl = process.env.REPO_URL || '';
const token = process.env.ACCESS_TOKEN || '';
const runnerName = process.env.RUNNER_NAME || '';
const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
const owner = match?.[1] || '';
const repo = (match?.[2] || '').replace(/\.git$/i, '');

function github(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'runner-status',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    });
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
    activeJobs,
    latestRuns,
    generatedAt: new Date().toISOString(),
  };
}

function render(status) {
  const runner = status.runner;
  const jobs = status.activeJobs.length
    ? status.activeJobs.map((job) => `<tr><td>${escapeHtml(job.name)}</td><td>${escapeHtml(job.status)}</td><td>${escapeHtml(job.conclusion || '-')}</td><td>${escapeHtml(job.runner_name || '-')}</td></tr>`).join('')
    : '<tr><td colspan="4">No active jobs</td></tr>';
  const runs = status.latestRuns.map((run) => `<tr><td><a href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">${run.id}</a></td><td>${escapeHtml(run.event)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.conclusion || '-')}</td><td>${escapeHtml(run.created_at)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>GitHub Runner Status</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 32px; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1120; color: #e5eefc; }
    .grid { display: grid; gap: 16px; max-width: 1100px; }
    .card { background: #121a2d; border: 1px solid #22304f; border-radius: 16px; padding: 20px; }
    .pill { display: inline-block; padding: 6px 10px; border-radius: 999px; font-size: 12px; background: #1d2842; margin-right: 8px; margin-bottom: 8px; }
    .ok { color: #67e8a5; }
    .warn { color: #fbbf24; }
    .bad { color: #f87171; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #22304f; font-size: 14px; }
    a { color: #93c5fd; text-decoration: none; }
  </style>
</head>
<body>
  <div class="grid">
    <div class="card">
      <h1>GitHub Self-Hosted Runner</h1>
      <p>Repository: <strong>${escapeHtml(status.repository)}</strong></p>
      <p>Generated: <code>${escapeHtml(status.generatedAt)}</code></p>
      ${runner ? `
        <p>Runner: <strong>${escapeHtml(runner.name)}</strong></p>
        <p>Status: <strong class="${runner.busy ? 'warn' : 'ok'}">${escapeHtml(runner.status)}</strong> | Busy: <strong class="${runner.busy ? 'warn' : 'ok'}">${runner.busy}</strong></p>
        <div>${runner.labels.map((label) => `<span class="pill">${escapeHtml(label)}</span>`).join('')}</div>
      ` : '<p class="bad">Runner not found in GitHub API.</p>'}
    </div>
    <div class="card">
      <h2>Active Jobs</h2>
      <table>
        <thead><tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th></tr></thead>
        <tbody>${jobs}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Latest Runs</h2>
      <table>
        <thead><tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th></tr></thead>
        <tbody>${runs}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const status = await getStatus();
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(render(status));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`status error: ${error.message}`);
  }
});

server.listen(8080, '0.0.0.0');

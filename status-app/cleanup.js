const path = require('path');

const DEFAULT_CLEANUP_COOLDOWN_MS = Number(process.env.CLEANUP_COOLDOWN_MS || 15 * 60 * 1000);
const DEFAULT_DANGLING_MAX_AGE = process.env.CLEANUP_DANGLING_MAX_AGE || '24h';
const DEFAULT_BUILD_CACHE_MAX_AGE = process.env.CLEANUP_BUILD_CACHE_MAX_AGE || '24h';
const DEFAULT_STALE_RESOURCE_MAX_AGE = process.env.CLEANUP_STALE_RESOURCE_MAX_AGE || '30m';
const DEFAULT_WORK_ROOT = process.env.RUNNER_HOST_WORK_ROOT || '/tmp/github-runner';
const DEFAULT_COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || 'github-runner-fleet';
const LEGACY_COMPOSE_PROJECT_NAME = 'github-selfhosted';
const MANAGED_LABEL = 'io.github-runner-fleet.managed';

function parseDurationMs(value, fallbackMs) {
  const candidate = String(value || '').trim();
  const match = candidate.match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[unit];

  return amount * multiplier;
}

function shouldRunCleanup({ status, cleanupState, now = Date.now() }) {
  if (!status || !Array.isArray(status.targets)) {
    return { ok: false, reason: 'runner-missing' };
  }

  const hasBusyRunner = status.targets.some((target) => (
    (target.githubRunners || []).some((runner) => runner.busy)
    || Boolean(target.activeRun)
    || (target.activeJobs || []).length > 0
  ));

  if (hasBusyRunner) {
    return { ok: false, reason: 'run-active' };
  }
  if (cleanupState.running) {
    return { ok: false, reason: 'cleanup-running' };
  }
  if (cleanupState.lastRunAt && now - cleanupState.lastRunAt < DEFAULT_CLEANUP_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown-active' };
  }

  return { ok: true, reason: 'runner-idle' };
}

function buildCleanupPlan({ status, dockerContainers, now = Date.now() }) {
  const activeRunnerNames = new Set(
    (status.targets || []).flatMap((target) => [
      ...(target.githubRunners || []).filter((runner) => runner.busy).map((runner) => runner.name),
      ...(target.localRunners || []).filter((runner) => runner.state === 'running').map((runner) => runner.runnerName),
    ]).filter(Boolean)
  );

  const staleThresholdMs = parseDurationMs(DEFAULT_STALE_RESOURCE_MAX_AGE, 30 * 60 * 1000);
  const acceptedComposeProjects = new Set([DEFAULT_COMPOSE_PROJECT_NAME, LEGACY_COMPOSE_PROJECT_NAME]);
  const staleManagedRunnerIds = [];
  const staleComposeProjects = new Map();

  for (const container of dockerContainers || []) {
    const labels = container.Labels || {};
    const createdMs = (container.Created || 0) * 1000;
    const isOldEnough = createdMs > 0 && now - createdMs >= staleThresholdMs;
    const runnerName = labels['io.github-runner-fleet.runner-name'] || '';
    const composeProject = labels['com.docker.compose.project'] || '';
    const workingDir = labels['com.docker.compose.project.working_dir'] || '';

    if (labels[MANAGED_LABEL] === 'true' && container.State !== 'running' && isOldEnough) {
      staleManagedRunnerIds.push(container.Id);
    }

    if (!composeProject || acceptedComposeProjects.has(composeProject) || activeRunnerNames.has(composeProject) || !isOldEnough) {
      continue;
    }

    if (!workingDir.startsWith(`${DEFAULT_WORK_ROOT}/`)) {
      continue;
    }

    const entry = staleComposeProjects.get(composeProject) || {
      project: composeProject,
      workdir: path.join(DEFAULT_WORK_ROOT, composeProject),
      containerIds: [],
      networkNames: new Set(),
    };
    entry.containerIds.push(container.Id);
    const network = labels['com.docker.compose.network'];
    if (network) {
      entry.networkNames.add(network);
    }
    staleComposeProjects.set(composeProject, entry);
  }

  return {
    staleManagedRunnerIds,
    staleComposeProjects: Array.from(staleComposeProjects.values()).map((entry) => ({
      ...entry,
      networkNames: Array.from(entry.networkNames),
    })),
  };
}

async function pruneDanglingResources(docker) {
  const imageFilters = encodeURIComponent(JSON.stringify({ dangling: { true: true }, until: { [DEFAULT_DANGLING_MAX_AGE]: true } }));
  const volumeFilters = encodeURIComponent(JSON.stringify({ dangling: { true: true } }));
  const buildFilters = encodeURIComponent(JSON.stringify({ until: { [DEFAULT_BUILD_CACHE_MAX_AGE]: true } }));

  const [images, volumes, buildCache] = await Promise.all([
    docker(`/images/prune?filters=${imageFilters}`, { method: 'POST' }),
    docker(`/volumes/prune?filters=${volumeFilters}`, { method: 'POST' }),
    docker(`/build/prune?filters=${buildFilters}`, { method: 'POST' }),
  ]);

  return {
    imagePrune: images.body,
    volumePrune: volumes.body,
    buildCachePrune: buildCache.body,
  };
}

module.exports = {
  buildCleanupPlan,
  parseDurationMs,
  shouldRunCleanup,
  pruneDanglingResources,
};

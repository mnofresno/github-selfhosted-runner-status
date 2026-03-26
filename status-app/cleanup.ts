const DEFAULT_CLEANUP_COOLDOWN_MS = Number(process.env.CLEANUP_COOLDOWN_MS || 15 * 60 * 1000);
export {};
const DEFAULT_DANGLING_MAX_AGE = process.env.CLEANUP_DANGLING_MAX_AGE || '24h';
const DEFAULT_BUILD_CACHE_MAX_AGE = process.env.CLEANUP_BUILD_CACHE_MAX_AGE || '24h';
const DEFAULT_STALE_RESOURCE_MAX_AGE = process.env.STACK_GRACE_MS || '30m';
const MANAGED_LABEL = 'io.github-runner-fleet.managed';
const MANAGED_STACK_LABEL = 'io.github-runner-fleet.stack-id';
const MANAGED_RUNNER_LABEL = 'io.github-runner-fleet.runner-name';
const MANAGED_TARGET_LABEL = 'io.github-runner-fleet.target-id';

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
    || (target.activeRuns || []).length > 0
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

function buildCleanupPlan({
  status,
  dockerContainers = [],
  dockerVolumes = [],
  dockerNetworks = [],
  now = Date.now(),
}) {
  const activeRunnerNames = new Set(
    (status.targets || [])
      .flatMap((target) => [
        ...(target.githubRunners || []).filter((runner) => runner.busy).map((runner) => runner.name),
        ...(target.activeJobs || []).map((job) => job.runner_name),
        ...(target.localRunners || []).filter((runner) => runner.state === 'running').map((runner) => runner.runnerName),
      ])
      .filter(Boolean),
  );

  const staleThresholdMs = parseDurationMs(DEFAULT_STALE_RESOURCE_MAX_AGE, 30 * 60 * 1000);
  const stacks = new Map();

  function ensureStack(labels, fallbackId) {
    const stackId = labels?.[MANAGED_STACK_LABEL] || labels?.[MANAGED_RUNNER_LABEL] || fallbackId;
    const existing = stacks.get(stackId);
    if (existing) {
      return existing;
    }

    const stack = {
      stackId,
      targetId: labels?.[MANAGED_TARGET_LABEL] || '',
      runnerName: labels?.[MANAGED_RUNNER_LABEL] || '',
      createdMs: 0,
      containerIds: [],
      volumeNames: [],
      networkNames: [],
      runningContainerIds: [],
    };
    stacks.set(stackId, stack);
    return stack;
  }

  for (const container of dockerContainers) {
    const labels = container.Labels || {};
    if (labels[MANAGED_LABEL] !== 'true') {
      continue;
    }

    const stack = ensureStack(labels, container.Id);
    const createdMs = parseCreatedMs(container.Created);
    if (createdMs && (!stack.createdMs || createdMs < stack.createdMs)) {
      stack.createdMs = createdMs;
    }
    stack.containerIds.push(container.Id);
    if (container.State === 'running') {
      stack.runningContainerIds.push(container.Id);
    }
  }

  for (const volume of dockerVolumes) {
    const labels = volume.Labels || {};
    if (labels[MANAGED_LABEL] !== 'true') {
      continue;
    }

    const stack = ensureStack(labels, volume.Name);
    const createdMs = parseCreatedMs(volume.CreatedAt);
    if (createdMs && (!stack.createdMs || createdMs < stack.createdMs)) {
      stack.createdMs = createdMs;
    }
    stack.volumeNames.push(volume.Name);
  }

  for (const network of dockerNetworks) {
    const labels = network.Labels || {};
    if (labels[MANAGED_LABEL] !== 'true') {
      continue;
    }

    const stack = ensureStack(labels, network.Name);
    const createdMs = parseCreatedMs(network.Created);
    if (createdMs && (!stack.createdMs || createdMs < stack.createdMs)) {
      stack.createdMs = createdMs;
    }
    stack.networkNames.push(network.Name);
  }

  const staleManagedStacks = Array.from(stacks.values()).filter((stack) => {
    if (!stack.createdMs || now - stack.createdMs < staleThresholdMs) {
      return false;
    }
    if (activeRunnerNames.has(stack.runnerName)) {
      return false;
    }
    return stack.runningContainerIds.length === 0;
  });

  return { staleManagedStacks };
}

async function pruneDanglingResources(docker) {
  const imageFilters = encodeURIComponent(JSON.stringify({ dangling: { true: true }, until: { [DEFAULT_DANGLING_MAX_AGE]: true } }));
  const buildFilters = encodeURIComponent(JSON.stringify({ until: { [DEFAULT_BUILD_CACHE_MAX_AGE]: true } }));

  const [images, volumes, buildCache] = await Promise.all([
    docker(`/images/prune?filters=${imageFilters}`, { method: 'POST' }),
    docker('/volumes/prune', { method: 'POST' }),
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

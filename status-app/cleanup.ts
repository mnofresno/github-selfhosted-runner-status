const DEFAULT_CLEANUP_COOLDOWN_MS = Number.parseInt(process.env.CLEANUP_COOLDOWN_MS || `${15 * 60 * 1000}`, 10);
const DEFAULT_DANGLING_MAX_AGE = process.env.CLEANUP_DANGLING_MAX_AGE || '24h';
const DEFAULT_BUILD_CACHE_MAX_AGE = process.env.CLEANUP_BUILD_CACHE_MAX_AGE || '24h';
const DEFAULT_STALE_RESOURCE_MAX_AGE = process.env.STACK_GRACE_MS || '30m';

const MANAGED_LABEL = 'io.github-runner-fleet.managed';
const MANAGED_STACK_LABEL = 'io.github-runner-fleet.stack-id';
const MANAGED_RUNNER_LABEL = 'io.github-runner-fleet.runner-name';
const MANAGED_TARGET_LABEL = 'io.github-runner-fleet.target-id';

function parseDurationMs(value, fallbackMs) {
  const candidate = String(value || '').trim();
  if (!candidate) {
    return fallbackMs;
  }

  if (/^\d+$/.test(candidate)) {
    return Number.parseInt(candidate, 10);
  }

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

function normalizeLabels(labels = {}) {
  return labels && typeof labels === 'object' ? labels : {};
}

function getStackId(labels, fallbackId) {
  return labels?.[MANAGED_STACK_LABEL] || labels?.[MANAGED_RUNNER_LABEL] || fallbackId || '';
}

function getManagedStackKey(labels, fallbackId) {
  return [
    labels?.[MANAGED_TARGET_LABEL] || '',
    labels?.[MANAGED_STACK_LABEL] || '',
    labels?.[MANAGED_RUNNER_LABEL] || '',
    fallbackId || '',
  ].join('::');
}

function hasManagedLabelSet(labels) {
  return labels?.[MANAGED_LABEL] === 'true';
}

function isManagedResource(labels) {
  return hasManagedLabelSet(labels);
}

function isManagedRunnerResource(labels) {
  if (labels?.[MANAGED_LABEL] === 'true') {
    return labels?.[MANAGED_RUNNER_LABEL] ? true : labels?.[MANAGED_STACK_LABEL] ? true : false;
  }
  return false;
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
  if (cleanupState?.running) {
    return { ok: false, reason: 'cleanup-running' };
  }
  const lastRunAtMs = typeof cleanupState?.lastRunAt === 'string'
    ? Date.parse(cleanupState.lastRunAt)
    : cleanupState?.lastRunAt;
  if (lastRunAtMs && now - lastRunAtMs < DEFAULT_CLEANUP_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown-active' };
  }

  return { ok: true, reason: 'runner-idle' };
}

function indexTargets(status) {
  return new Map((status?.targets || []).map((target) => [target.id, target]));
}

function mergeStackEntry(stacks, labels, fallbackId, createdMs, kind, name, extra = {}) {
  const stackId = getStackId(labels, fallbackId);
  const key = getManagedStackKey(labels, stackId || fallbackId);
  const existing = stacks.get(key);
  const entry = existing || {
    stackId,
    targetId: labels?.[MANAGED_TARGET_LABEL] || '',
    runnerName: labels?.[MANAGED_RUNNER_LABEL] || '',
    createdMs: 0,
    containerIds: [],
    volumeNames: [],
    networkNames: [],
    labels: normalizeLabels(labels),
    labelCompleteness: {
      managed: isManagedResource(labels),
      targetId: Boolean(labels?.[MANAGED_TARGET_LABEL]),
      runnerName: Boolean(labels?.[MANAGED_RUNNER_LABEL]),
      stackId: Boolean(labels?.[MANAGED_STACK_LABEL]),
    },
    ...extra,
  };

  if (createdMs && (!entry.createdMs || createdMs < entry.createdMs)) {
    entry.createdMs = createdMs;
  }

  if (kind === 'container' && name) {
    entry.containerIds.push(name);
  } else if (kind === 'volume' && name) {
    entry.volumeNames.push(name);
  } else if (kind === 'network' && name) {
    entry.networkNames.push(name);
  }

  stacks.set(key, entry);
  return entry;
}

function buildFleetCleanupPlan({
  status,
  dockerContainers = [],
  dockerVolumes = [],
  dockerNetworks = [],
  now = Date.now(),
  stackGraceMs = parseDurationMs(DEFAULT_STALE_RESOURCE_MAX_AGE, 30 * 60 * 1000),
}) {
  const targetsById = indexTargets(status);
  const activeRunnerNames = new Set(
    (status?.targets || [])
      .flatMap((target) => [
        ...(target.githubRunners || []).filter((runner) => runner.busy).map((runner) => runner.name),
        ...(target.activeJobs || []).map((job) => job.runner_name),
        ...(target.localRunners || [])
          .filter((runner) => runner.state === 'running')
          .map((runner) => runner.runnerName || runner.name),
      ])
      .filter(Boolean),
  );

  const stacks = new Map();
  const ignoredResources = [];

  for (const container of dockerContainers) {
    const labels = normalizeLabels(container.Labels);
    if (!isManagedResource(labels)) {
      continue;
    }

    const createdMs = parseCreatedMs(container.Created);
    const entry = mergeStackEntry(stacks, labels, container.Id, createdMs, 'container', container.Id);
    if (container.State === 'running') {
      entry.running = true;
    }
    if (!labels?.[MANAGED_TARGET_LABEL] || !labels?.[MANAGED_RUNNER_LABEL] || !labels?.[MANAGED_STACK_LABEL]) {
      ignoredResources.push({
        type: 'container',
        id: container.Id,
        reason: 'incomplete-labels',
      });
    }
  }

  for (const volume of dockerVolumes) {
    const labels = normalizeLabels(volume.Labels);
    if (!isManagedResource(labels)) {
      continue;
    }

    const createdMs = parseCreatedMs(volume.CreatedAt);
    mergeStackEntry(stacks, labels, volume.Name, createdMs, 'volume', volume.Name);
    if (!labels?.[MANAGED_TARGET_LABEL] || !labels?.[MANAGED_RUNNER_LABEL] || !labels?.[MANAGED_STACK_LABEL]) {
      ignoredResources.push({
        type: 'volume',
        id: volume.Name,
        reason: 'incomplete-labels',
      });
    }
  }

  for (const network of dockerNetworks) {
    const labels = normalizeLabels(network.Labels);
    if (!isManagedResource(labels)) {
      continue;
    }

    const createdMs = parseCreatedMs(network.Created);
    mergeStackEntry(stacks, labels, network.Name, createdMs, 'network', network.Name);
    if (!labels?.[MANAGED_TARGET_LABEL] || !labels?.[MANAGED_RUNNER_LABEL] || !labels?.[MANAGED_STACK_LABEL]) {
      ignoredResources.push({
        type: 'network',
        id: network.Name,
        reason: 'incomplete-labels',
      });
    }
  }

  const staleManagedStacks = Array.from(stacks.values()).filter((stack) => {
    if (!stack.stackId || !stack.createdMs) {
      return false;
    }
    if (stack.running) {
      return false;
    }
    if (now - stack.createdMs < stackGraceMs) {
      return false;
    }

    const target: any = targetsById.get(stack.targetId);
    const targetIsConfigured = Boolean(target);
    const targetHasCapacity = Boolean(target?.runnersCount > 0);
    const targetHasBusyWork = Boolean(
      (target?.githubRunners || []).some((runner) => runner.busy)
      || (target?.activeRuns || []).length > 0
      || (target?.activeJobs || []).length > 0,
    );
    const targetNeedsProtection = targetIsConfigured && targetHasCapacity && !targetHasBusyWork;

    if (targetNeedsProtection && now - stack.createdMs < stackGraceMs) {
      return false;
    }

    if (activeRunnerNames.has(stack.runnerName)) {
      return false;
    }

    return !targetHasBusyWork;
  }).map((stack) => ({
    stackId: stack.stackId,
    targetId: stack.targetId,
    runnerName: stack.runnerName,
    createdMs: stack.createdMs,
    ageMs: now - stack.createdMs,
    targetConfigured: Boolean(targetsById.get(stack.targetId)),
    containerIds: [...stack.containerIds],
    volumeNames: [...stack.volumeNames],
    networkNames: [...stack.networkNames],
    labelCompleteness: stack.labelCompleteness,
  }));

  return {
    staleManagedStacks,
    ignoredResources,
  };
}

async function pruneGlobalResources(docker, options: any = {}) {
  const { danglingMaxAge = DEFAULT_DANGLING_MAX_AGE, buildCacheMaxAge = DEFAULT_BUILD_CACHE_MAX_AGE } = options || {};

  const imageFilters = encodeURIComponent(JSON.stringify({
    dangling: { true: true },
    until: { [danglingMaxAge]: true },
  }));
  const buildFilters = encodeURIComponent(JSON.stringify({
    until: { [buildCacheMaxAge]: true },
  }));

  const [images, buildCache] = await Promise.all([
    docker(`/images/prune?filters=${imageFilters}`, { method: 'POST' }),
    docker(`/build/prune?filters=${buildFilters}`, { method: 'POST' }),
  ]);

  return {
    imagePrune: images.body,
    buildCachePrune: buildCache.body,
    volumePrune: { skipped: true, reason: 'disabled-by-default' },
  };
}

async function executeFleetCleanupPlan({
  plan,
  removeStack,
  pruneGlobalResourcesFn,
  reconcileTargets = [],
  ensureRunnersForTarget,
}) {
  const removedStacks = [];
  const errors = [];

  for (const stack of plan?.staleManagedStacks || []) {
    try {
      await removeStack(stack.stackId, stack);
      removedStacks.push(stack);
    } catch (error) {
      errors.push({ stackId: stack.stackId, error: error.message });
    }
  }

  let pruneResult = null;
  if (typeof pruneGlobalResourcesFn === 'function') {
    try {
      pruneResult = await pruneGlobalResourcesFn();
    } catch (error) {
      errors.push({ scope: 'global', error: error.message });
      pruneResult = { error: error.message };
    }
  }

  const reconciledTargets = [];
  if (typeof ensureRunnersForTarget === 'function') {
    for (const target of reconcileTargets) {
      try {
        const result = await ensureRunnersForTarget(target);
        reconciledTargets.push({
          targetId: target.id,
          results: result,
        });
      } catch (error) {
        errors.push({ targetId: target.id, error: error.message });
      }
    }
  }

  return {
    removedStacks,
    pruneResult,
    reconciledTargets,
    errors,
  };
}

function buildCleanupState() {
  return {
    running: false,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastStartedAt: null,
  };
}

function snapshotCleanupState(state) {
  return {
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    lastStartedAt: state.lastStartedAt,
  };
}

function createCleanupRuntime() {
  return {
    maintenanceRunning: false,
    fleet: buildCleanupState(),
    global: buildCleanupState(),
  };
}

function getCleanupStatus(runtime) {
  return {
    maintenanceRunning: runtime.maintenanceRunning,
    fleet: snapshotCleanupState(runtime.fleet),
    global: snapshotCleanupState(runtime.global),
  };
}

async function withCleanupLock(runtime, task) {
  if (runtime.maintenanceRunning) {
    return { skipped: true, reason: 'maintenance-running' };
  }

  runtime.maintenanceRunning = true;
  try {
    return await task();
  } finally {
    runtime.maintenanceRunning = false;
  }
}

module.exports = {
  buildCleanupState,
  buildCleanupPlan: buildFleetCleanupPlan,
  buildFleetCleanupPlan,
  createCleanupRuntime,
  executeFleetCleanupPlan,
  getCleanupStatus,
  parseDurationMs,
  pruneDanglingResources: pruneGlobalResources,
  pruneGlobalResources,
  shouldRunCleanup,
  snapshotCleanupState,
  withCleanupLock,
};

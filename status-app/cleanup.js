const DEFAULT_CLEANUP_COOLDOWN_MS = Number(process.env.CLEANUP_COOLDOWN_MS || 15 * 60 * 1000);
const DEFAULT_DANGLING_MAX_AGE = process.env.CLEANUP_DANGLING_MAX_AGE || '24h';
const DEFAULT_BUILD_CACHE_MAX_AGE = process.env.CLEANUP_BUILD_CACHE_MAX_AGE || '24h';

function shouldRunCleanup({ status, cleanupState, now = Date.now() }) {
  if (!status || !status.runner) {
    return { ok: false, reason: 'runner-missing' };
  }
  if (status.runner.busy) {
    return { ok: false, reason: 'runner-busy' };
  }
  if (status.activeRun || (status.activeJobs || []).length > 0) {
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
  shouldRunCleanup,
  pruneDanglingResources,
};

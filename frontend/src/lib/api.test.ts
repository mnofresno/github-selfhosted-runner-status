import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed data for successful requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generatedAt: 'now', targets: [] }),
    }));

    await expect(api.getStatus()).resolves.toEqual({ generatedAt: 'now', targets: [] });
  });

  it('throws request errors with backend messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'not allowed' }),
    }));

    await expect(api.restartTarget('fleet-a')).rejects.toThrow('not allowed');
  });

  it('calls all remaining endpoints with the right URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.addTarget({ name: 'A', scope: 'org', owner: 'octo', labels: 'self-hosted', runnersCount: 1 });
    await api.removeTarget('fleet-a');
    await api.updateTarget('fleet-a', { runnersCount: 3 });
    await api.getOwners('fleet-a', 'oc');
    await api.getRepos('fleet-a', 'octo', 'we');
    await api.getJobs('fleet-a', 101);
    await api.cancelRun('fleet-a', 101);
    await api.rerunRun('fleet-a', 101);
    await api.rerunFailed('fleet-a', 101);
    await api.rerunJob('fleet-a', 55);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/targets',
      '/api/targets/fleet-a',
      '/api/targets/fleet-a',
      '/api/github/owners?targetId=fleet-a&q=oc',
      '/api/github/repos?owner=octo&targetId=fleet-a&q=we',
      '/api/targets/fleet-a/runs/101/jobs',
      '/api/targets/fleet-a/runs/101/cancel',
      '/api/targets/fleet-a/runs/101/rerun',
      '/api/targets/fleet-a/runs/101/rerun-failed',
      '/api/targets/fleet-a/jobs/55/rerun',
    ]);
  });
});

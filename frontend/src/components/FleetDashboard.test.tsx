import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetDashboard } from './FleetDashboard';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    cancelRun: vi.fn(),
  },
}));

describe('FleetDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders health states and opens target tabs from the overview', async () => {
    const user = userEvent.setup();
    const onSelectTarget = vi.fn();
    const onCleanupFleet = vi.fn().mockResolvedValue(undefined);
    const onCleanupGlobal = vi.fn().mockResolvedValue(undefined);

    render(
      <FleetDashboard
        activeTargetId="fleet-b"
        busy={false}
        cleanupStatus={{
          maintenanceRunning: false,
          fleet: { running: false, lastRunAt: '2026-03-19T15:05:00.000Z', lastStartedAt: '2026-03-19T15:00:00.000Z', lastError: null, lastResult: {
            mode: 'fleet',
            startedAt: '2026-03-19T15:00:00.000Z',
            finishedAt: '2026-03-19T15:05:00.000Z',
            durationMs: 300000,
            plan: { staleManagedStacks: [{ stackId: 'stack-a', targetId: 'fleet-a', runnerName: 'runner-a', createdMs: 1, ageMs: 1000, targetConfigured: true, containerIds: ['c1'], volumeNames: ['v1'], networkNames: ['n1'], labelCompleteness: { managed: true, targetId: true, runnerName: true, stackId: true } }], ignoredResources: [] },
            removedStacks: [],
            pruneResult: { imagePrune: { SpaceReclaimed: 0 }, buildCachePrune: { SpaceReclaimed: 0 }, volumePrune: { skipped: true } },
            reconciledTargets: [],
            errors: [],
          } },
          global: { running: false, lastRunAt: '2026-03-19T15:10:00.000Z', lastStartedAt: '2026-03-19T15:08:00.000Z', lastError: null, lastResult: {
            mode: 'global',
            startedAt: '2026-03-19T15:08:00.000Z',
            finishedAt: '2026-03-19T15:10:00.000Z',
            durationMs: 120000,
            pruneResult: { imagePrune: { SpaceReclaimed: 1024 }, buildCachePrune: { SpaceReclaimed: 2048 }, volumePrune: { skipped: true } },
            statusAtRun: { targets: [] },
          } },
        }}
        onBusyChange={vi.fn()}
        onSelectTarget={onSelectTarget}
        onStatusChange={vi.fn()}
        onCleanupFleet={onCleanupFleet}
        onCleanupGlobal={onCleanupGlobal}
        status={{
          generatedAt: '2026-03-19T15:00:00.000Z',
          targets: [
            {
              id: 'fleet-a',
              name: 'Fleet A',
              scope: 'repo',
              owner: 'octo',
              repo: 'web',
              repository: 'octo/web',
              labels: ['self-hosted'],
              runnersCount: 1,
              localRunners: [{ name: 'fleet-a-0', state: 'running', status: 'Up', cpuPercent: 10.5, memoryBytes: 256 * 1024 * 1024, diskBytes: 2 * 1024 * 1024 * 1024 }],
              githubRunners: [{ id: 1, name: 'gh-a', status: 'online', busy: false, labels: ['linux'], os: 'linux' }],
              latestRuns: [{ id: 101, name: 'build', event: 'push', status: 'completed', conclusion: 'success', url: '#', created_at: 'now' }],
              activeRuns: [],
            },
            {
              id: 'fleet-b',
              name: 'Fleet B',
              scope: 'org',
              owner: 'octo',
              repository: 'octo',
              labels: ['self-hosted'],
              runnersCount: 2,
              localRunners: [{ name: 'fleet-b-0', state: 'running', status: 'Up', cpuPercent: 4.5, memoryBytes: 128 * 1024 * 1024, diskBytes: 1024 * 1024 * 1024 }],
              githubRunners: [{ id: 2, name: 'gh-b', status: 'offline', busy: true, labels: ['linux'], os: 'linux' }],
              latestRuns: [],
              activeRuns: [
                { id: 103, name: 'queued deploy', event: 'workflow_dispatch', status: 'queued', conclusion: null, url: '#', created_at: 'now' },
                { id: 102, name: 'deploy', event: 'workflow_dispatch', status: 'in_progress', conclusion: null, url: '#', created_at: 'now' },
              ],
            },
            {
              id: 'fleet-c',
              name: 'Fleet C',
              scope: 'org',
              owner: 'space',
              repository: 'space',
              labels: ['self-hosted'],
              runnersCount: 1,
              localRunners: [],
              githubRunners: [],
              latestRuns: [],
              activeRuns: [],
            },
          ],
        }}
      />,
    );

    expect(screen.getAllByText('healthy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('degraded').length).toBeGreaterThan(0);
    expect(screen.getAllByText('down').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 active job').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No repo feed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10.5%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('256 MB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.0 GB').length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Open' })[0]);
    expect(onSelectTarget).toHaveBeenCalledWith('fleet-a');

    expect(screen.getByRole('heading', { name: 'Cleanup control' })).toBeInTheDocument();
    expect(screen.getByText('Fleet stale stacks')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cleanup fleet' }));
    await user.click(screen.getByRole('button', { name: 'Cleanup global' }));
    expect(onCleanupFleet).toHaveBeenCalled();
    expect(onCleanupGlobal).toHaveBeenCalled();

    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelRun).toHaveBeenCalledWith('fleet-b', 102);
  });
});

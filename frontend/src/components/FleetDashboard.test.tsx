import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetDashboard } from './FleetDashboard';

describe('FleetDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders health states and opens target tabs from the overview', async () => {
    const user = userEvent.setup();
    const onSelectTarget = vi.fn();

    render(
      <FleetDashboard
        activeTargetId="fleet-b"
        onSelectTarget={onSelectTarget}
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
              localRunners: [{ name: 'fleet-a-0', state: 'running', status: 'Up' }],
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
              localRunners: [{ name: 'fleet-b-0', state: 'running', status: 'Up' }],
              githubRunners: [{ id: 2, name: 'gh-b', status: 'offline', busy: true, labels: ['linux'], os: 'linux' }],
              latestRuns: [],
              activeRuns: [{ id: 102, name: 'deploy', event: 'workflow_dispatch', status: 'in_progress', conclusion: null, url: '#', created_at: 'now' }],
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

    await user.click(screen.getAllByRole('button', { name: 'Open' })[0]);
    expect(onSelectTarget).toHaveBeenCalledWith('fleet-a');
  });
});

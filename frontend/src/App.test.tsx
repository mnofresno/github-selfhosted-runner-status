import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './lib/api';

vi.mock('./lib/api', () => ({
  api: {
    getStatus: vi.fn(),
    getCleanupStatus: vi.fn(),
    cleanupFleet: vi.fn(),
    cleanupGlobal: vi.fn(),
    addTarget: vi.fn(),
    removeTarget: vi.fn(),
    restartTarget: vi.fn(),
    reconcileTarget: vi.fn(),
    updateTarget: vi.fn(),
    getOwners: vi.fn(),
    getRepos: vi.fn(),
    getJobs: vi.fn(),
    rerunRun: vi.fn(),
    rerunFailed: vi.fn(),
    rerunJob: vi.fn(),
    cancelRun: vi.fn(),
  },
}));

const statusFixture = {
  generatedAt: '2026-03-19T14:00:00.000Z',
  targets: [
    {
      id: 'fleet-a',
      name: 'Fleet A',
      scope: 'repo' as const,
      owner: 'octo',
      repo: 'web',
      repository: 'octo/web',
      labels: ['self-hosted', 'linux'],
      runnersCount: 2,
      runnerGroup: 'Default',
      description: 'Primary fleet',
      localRunners: [
        { name: 'fleet-a-0', state: 'running', status: 'Up', image: 'runner:latest', cpuPercent: 8.5, memoryBytes: 256 * 1024 * 1024, diskBytes: 2 * 1024 * 1024 * 1024 },
        { name: 'fleet-a-1', state: 'exited', status: 'Exited', image: 'runner:latest', cpuPercent: 0, memoryBytes: 64 * 1024 * 1024, diskBytes: 512 * 1024 * 1024 },
      ],
      githubRunners: [
        { id: 1, name: 'gh-runner-1', status: 'online', busy: true, labels: ['linux'], os: 'linux' },
      ],
      latestRuns: [
        { id: 101, name: 'build', event: 'push', status: 'completed', conclusion: 'success', url: 'https://example.com/run/101', created_at: 'now' },
      ],
      activeRuns: [{ id: 102, name: 'deploy', event: 'workflow_dispatch', status: 'in_progress', conclusion: null, url: 'https://example.com/run/102', created_at: 'now' }],
    },
  ],
};

describe('App', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('setInterval', vi.fn(() => 1));
    vi.stubGlobal('clearInterval', vi.fn());
    (api.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(statusFixture);
    (api.getCleanupStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      maintenanceRunning: false,
      fleet: { running: false, lastRunAt: null, lastStartedAt: null, lastResult: null, lastError: null },
      global: { running: false, lastRunAt: null, lastStartedAt: null, lastResult: null, lastError: null },
    });
    (api.getOwners as ReturnType<typeof vi.fn>).mockResolvedValue(['octo']);
    (api.getRepos as ReturnType<typeof vi.fn>).mockResolvedValue(['web']);
    (api.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 55, name: 'lint', status: 'completed', conclusion: 'success', runner_name: 'gh-runner-1', html_url: 'https://example.com/job/55' },
    ]);
    (api.addTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.restartTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.reconcileTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.removeTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.updateTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunFailed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunJob as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.cancelRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('loads and renders fleet status', async () => {
    render(<App />);

    expect(screen.getByText('Loading fleet status...')).toBeInTheDocument();

    await screen.findByRole('heading', { name: 'Fleet overview' });
    expect(screen.getAllByText('octo/web').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 active job').length).toBeGreaterThan(0);
    expect(screen.getAllByText('320 MB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.5 GB').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Fleet A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add target' })).toBeInTheDocument();
    expect(api.getStatus).toHaveBeenCalled();
    expect(api.getCleanupStatus).toHaveBeenCalled();
  });

  it('submits a new target and refreshes the dashboard', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Fleet overview' });

    await user.click(screen.getByRole('button', { name: 'Add target' }));
    await screen.findByRole('heading', { name: 'Add Target' });

    await user.type(screen.getByLabelText('Name'), 'New Fleet');
    await user.type(screen.getByLabelText('Owner / Org'), 'octo');
    await user.click(screen.getAllByRole('button', { name: 'Add and Start Runners' })[0]);

    await waitFor(() => {
      expect(api.addTarget).toHaveBeenCalledWith(expect.objectContaining({
        name: 'New Fleet',
        owner: 'octo',
        scope: 'org',
      }));
    });
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it('shows jobs and lets a run cancel and job rerun be requested', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Fleet overview' });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelRun).toHaveBeenCalledWith('fleet-a', 102);

    await user.click(screen.getByRole('button', { name: 'Fleet A' }));
    await screen.findByRole('heading', { name: 'Fleet A' });

    await user.click(screen.getByRole('button', { name: 'Jobs' }));
    await screen.findByText('lint');
    await user.click(screen.getAllByRole('button', { name: 'Rerun' }).at(-1)!);

    expect(api.getJobs).toHaveBeenCalledWith('fleet-a', 101);
    expect(api.rerunJob).toHaveBeenCalledWith('fleet-a', 55);
  });

  it('restarts and removes a target', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Fleet overview' });

    await user.click(screen.getByRole('button', { name: 'Fleet A' }));
    await screen.findByRole('heading', { name: 'Fleet A' });

    const buttons = screen.getAllByRole('button', { name: 'Restart runners' });
    await user.click(buttons[0]);
    await waitFor(() => expect(api.restartTarget).toHaveBeenCalledWith('fleet-a'));

    await user.click(screen.getByRole('button', { name: 'Remove target' }));
    await waitFor(() => expect(api.removeTarget).toHaveBeenCalledWith('fleet-a'));
  });

  it('runs cleanup actions from the dashboard', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Fleet overview' });

    await user.click(screen.getByRole('button', { name: 'Cleanup fleet' }));
    await waitFor(() => expect(api.cleanupFleet).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Cleanup global' }));
    await waitFor(() => expect(api.cleanupGlobal).toHaveBeenCalled());
  });

  it('updates runner capacity for an existing target', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Fleet overview' });

    await user.click(screen.getByRole('button', { name: 'Fleet A' }));
    await screen.findByRole('heading', { name: 'Fleet A' });

    await user.click(screen.getByRole('button', { name: 'Increase runners' }));
    await waitFor(() => expect(api.updateTarget).toHaveBeenCalledWith('fleet-a', { runnersCount: 3 }));
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it('surfaces fetch errors', async () => {
    (api.getStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });
});

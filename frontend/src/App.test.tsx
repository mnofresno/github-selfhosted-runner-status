import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { api } from './lib/api';

vi.mock('./lib/api', () => ({
  api: {
    getStatus: vi.fn(),
    addTarget: vi.fn(),
    removeTarget: vi.fn(),
    restartTarget: vi.fn(),
    getOwners: vi.fn(),
    getRepos: vi.fn(),
    getJobs: vi.fn(),
    rerunRun: vi.fn(),
    rerunFailed: vi.fn(),
    rerunJob: vi.fn(),
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
        { name: 'fleet-a-0', state: 'running', status: 'Up', image: 'runner:latest' },
        { name: 'fleet-a-1', state: 'exited', status: 'Exited', image: 'runner:latest' },
      ],
      githubRunners: [
        { id: 1, name: 'gh-runner-1', status: 'online', busy: true, labels: ['linux'], os: 'linux' },
      ],
      latestRuns: [
        { id: 101, name: 'build', event: 'push', status: 'completed', conclusion: 'success', url: 'https://example.com/run/101', created_at: 'now' },
      ],
      activeRuns: [],
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
    (api.getOwners as ReturnType<typeof vi.fn>).mockResolvedValue(['octo']);
    (api.getRepos as ReturnType<typeof vi.fn>).mockResolvedValue(['web']);
    (api.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 55, name: 'lint', status: 'completed', conclusion: 'success', runner_name: 'gh-runner-1', html_url: 'https://example.com/job/55' },
    ]);
    (api.addTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.restartTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.removeTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunFailed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunJob as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('loads and renders fleet status', async () => {
    render(<App />);

    expect(screen.getByText('Loading fleet status...')).toBeInTheDocument();

    await screen.findByRole('heading', { name: 'Fleet A' });
    expect(screen.getAllByText('octo/web').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1/2').length).toBeGreaterThan(0);
    expect(api.getStatus).toHaveBeenCalled();
  });

  it('submits a new target and refreshes the dashboard', async () => {
    const user = userEvent.setup();
    render(<App />);
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

  it('shows jobs and lets a job rerun be requested', async () => {
    const user = userEvent.setup();
    render(<App />);
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
    await screen.findByRole('heading', { name: 'Fleet A' });

    const buttons = screen.getAllByRole('button', { name: 'Restart runners' });
    await user.click(buttons[0]);
    await waitFor(() => expect(api.restartTarget).toHaveBeenCalledWith('fleet-a'));

    await user.click(screen.getByRole('button', { name: 'Remove target' }));
    await waitFor(() => expect(api.removeTarget).toHaveBeenCalledWith('fleet-a'));
  });

  it('surfaces fetch errors', async () => {
    (api.getStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });
});

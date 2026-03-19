import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TargetCard } from './TargetCard';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getJobs: vi.fn(),
    removeTarget: vi.fn(),
    restartTarget: vi.fn(),
    rerunRun: vi.fn(),
    rerunFailed: vi.fn(),
    rerunJob: vi.fn(),
  },
}));

const baseTarget = {
  id: 'fleet-a',
  name: 'Fleet A',
  scope: 'repo' as const,
  owner: 'octo',
  repo: 'web',
  repository: 'octo/web',
  labels: ['self-hosted'],
  runnersCount: 1,
  description: '',
  localRunners: [{ name: 'runner-1', state: 'running', status: 'Up', image: 'runner' }],
  githubRunners: [{ id: 1, name: 'gh-runner', status: 'online', busy: false, labels: ['linux'], os: 'linux' }],
  latestRuns: [{ id: 101, name: 'build', event: 'push', status: 'completed', conclusion: 'success', url: 'https://example.com/run/101', created_at: 'now' }],
  activeRuns: [],
};

describe('TargetCard', () => {
  const onBusyChange = vi.fn();
  const onStatusChange = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
    (api.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (api.removeTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.restartTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunRun as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunFailed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (api.rerunJob as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows empty repo feed state when no repo is configured', () => {
    render(
      <TargetCard
        target={{ ...baseTarget, scope: 'org', repo: undefined, repository: 'octo', latestRuns: [] }}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText('Configure a repo to see run history.')).toBeInTheDocument();
  });

  it('restarts, removes, and reruns workflow actions', async () => {
    const user = userEvent.setup();
    render(
      <TargetCard
        target={baseTarget}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: 'Restart runners' }).at(-1)!);
    await user.click(screen.getByRole('button', { name: 'Remove target' }));
    await user.click(screen.getAllByRole('button', { name: 'Rerun' }).at(-1)!);
    await user.click(screen.getByRole('button', { name: 'Retry failed' }));

    expect(api.restartTarget).toHaveBeenCalledWith('fleet-a');
    expect(api.removeTarget).toHaveBeenCalledWith('fleet-a');
    expect(api.rerunRun).toHaveBeenCalledWith('fleet-a', 101);
    expect(api.rerunFailed).toHaveBeenCalledWith('fleet-a', 101);
  });

  it('loads jobs and reruns a job from the jobs panel', async () => {
    const user = userEvent.setup();
    (api.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 55, name: 'lint', status: 'completed', conclusion: 'success', runner_name: 'gh-runner', html_url: 'https://example.com/job/55' },
    ]);

    render(
      <TargetCard
        target={baseTarget}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: 'Jobs' }).at(-1)!);
    await screen.findByText('lint');
    await user.click(screen.getAllByRole('button', { name: 'Rerun' }).at(-1)!);

    await waitFor(() => expect(api.rerunJob).toHaveBeenCalledWith('fleet-a', 55));
  });

  it('renders empty states and skips removal when confirmation is cancelled', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => false));

    render(
      <TargetCard
        target={{
          ...baseTarget,
          description: 'Secondary fleet',
          labels: [],
          localRunners: [],
          githubRunners: [],
          latestRuns: [],
        }}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText('Secondary fleet')).toBeInTheDocument();
    expect(screen.getByText('No runners configured.')).toBeInTheDocument();
    expect(screen.getByText('No registered runners in GitHub.')).toBeInTheDocument();
    expect(screen.getByText('No recent runs.')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove target' }));
    expect(api.removeTarget).not.toHaveBeenCalled();
  });

  it('shows an empty jobs panel when a run has no jobs', async () => {
    const user = userEvent.setup();
    (api.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(
      <TargetCard
        target={baseTarget}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jobs' }));
    await screen.findByText('No jobs found.');
  });
});

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddTargetCard } from './AddTargetCard';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    addTarget: vi.fn(),
    getOwners: vi.fn(),
    getRepos: vi.fn(),
  },
}));

const targets = [
  {
    id: 'fleet-a',
    name: 'Fleet A',
    scope: 'org' as const,
    owner: 'octo',
    repository: 'octo',
    labels: ['self-hosted'],
    runnersCount: 1,
    localRunners: [],
    githubRunners: [],
    latestRuns: [],
    activeRuns: [],
  },
];

describe('AddTargetCard', () => {
  const onBusyChange = vi.fn();
  const onStatusChange = vi.fn();
  const onSubmitted = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    (api.getOwners as ReturnType<typeof vi.fn>).mockResolvedValue(['octo']);
    (api.getRepos as ReturnType<typeof vi.fn>).mockResolvedValue(['web']);
    (api.addTarget as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows validation errors for invalid repo targets', async () => {
    const user = userEvent.setup();
    render(
      <AddTargetCard
        targets={targets}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onSubmitted={onSubmitted}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Scope'), 'repo');
    await user.type(screen.getByLabelText('Name'), 'Repo fleet');
    await user.type(screen.getByLabelText('Owner / Org'), 'bad owner!');
    await user.click(screen.getByRole('button', { name: 'Add and Start Runners' }));

    expect(onStatusChange).toHaveBeenCalledWith('Fix the highlighted fields before adding the target.');
    expect(screen.getByText('Only letters, numbers, ".", "_" and "-" are allowed.')).toBeInTheDocument();
  });

  it('loads suggestions and submits repo targets', async () => {
    const user = userEvent.setup();
    render(
      <AddTargetCard
        targets={targets}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onSubmitted={onSubmitted}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Scope'), 'repo');
    await user.type(screen.getByLabelText('Name'), 'Repo fleet');
    await user.type(screen.getByLabelText('Owner / Org'), 'octo');
    await user.click(screen.getAllByRole('button', { name: 'Suggest' })[0]);
    await user.type(screen.getByLabelText('Repository (for run feed)'), 'web');
    await user.click(screen.getAllByRole('button', { name: 'Suggest' })[1]);
    await user.click(screen.getByRole('button', { name: 'Add and Start Runners' }));

    await waitFor(() => {
      expect(api.addTarget).toHaveBeenCalledWith(expect.objectContaining({
        scope: 'repo',
        owner: 'octo',
        repo: 'web',
      }));
    });
    expect(api.getOwners).toHaveBeenCalled();
    expect(api.getRepos).toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalled();
  });

  it('disables repo suggestions without an owner and reports submission failures', async () => {
    const user = userEvent.setup();
    (api.addTarget as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('save failed'));

    render(
      <AddTargetCard
        targets={targets}
        busy={false}
        onBusyChange={onBusyChange}
        onStatusChange={onStatusChange}
        onSubmitted={onSubmitted}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Suggest' })[1]).toBeDisabled();
    expect(api.getRepos).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Name'), 'Broken Fleet');
    await user.type(screen.getByLabelText('Owner / Org'), 'octo');
    await user.click(screen.getByRole('button', { name: 'Add and Start Runners' }));

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith('Failed: save failed');
    });
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

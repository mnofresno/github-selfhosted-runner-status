import type { FleetStatus, TargetFormPayload, TargetUpdatePayload, WorkflowJob } from '../types';

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || 'Unexpected request failure');
  }

  return payload as T;
}

export const api = {
  getStatus(): Promise<FleetStatus> {
    return readJson<FleetStatus>('/api/status');
  },
  addTarget(payload: TargetFormPayload): Promise<void> {
    return readJson<void>('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  removeTarget(targetId: string): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
  },
  updateTarget(targetId: string, payload: TargetUpdatePayload): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  restartTarget(targetId: string): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}/restart`, { method: 'POST' });
  },
  getOwners(targetId: string, q: string): Promise<string[]> {
    const params = new URLSearchParams();
    if (targetId) params.set('targetId', targetId);
    if (q.trim()) params.set('q', q.trim());
    return readJson<string[]>(`/api/github/owners?${params.toString()}`);
  },
  getRepos(targetId: string, owner: string, q: string): Promise<string[]> {
    const params = new URLSearchParams({ owner });
    if (targetId) params.set('targetId', targetId);
    if (q.trim()) params.set('q', q.trim());
    return readJson<string[]>(`/api/github/repos?${params.toString()}`);
  },
  getJobs(targetId: string, runId: number): Promise<WorkflowJob[]> {
    return readJson<WorkflowJob[]>(`/api/targets/${encodeURIComponent(targetId)}/runs/${runId}/jobs`);
  },
  rerunRun(targetId: string, runId: number): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}/runs/${runId}/rerun`, { method: 'POST' });
  },
  cancelRun(targetId: string, runId: number): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}/runs/${runId}/cancel`, { method: 'POST' });
  },
  rerunFailed(targetId: string, runId: number): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}/runs/${runId}/rerun-failed`, { method: 'POST' });
  },
  rerunJob(targetId: string, jobId: number): Promise<void> {
    return readJson<void>(`/api/targets/${encodeURIComponent(targetId)}/jobs/${jobId}/rerun`, { method: 'POST' });
  },
};

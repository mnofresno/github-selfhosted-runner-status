import { useState } from 'react';
import { api } from '../lib/api';
import type { Target, WorkflowJob, WorkflowRun } from '../types';

type TargetCardProps = {
  target: Target;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (message: string) => void;
  onRefresh: () => Promise<void>;
};

function LabelList({ labels }: { labels: string[] }) {
  if (!labels.length) return <span className="muted">none</span>;
  return (
    <>
      {labels.map((label) => (
        <span key={label} className="pill">{label}</span>
      ))}
    </>
  );
}

function Tone({ value, tone }: { value: string; tone: 'ok' | 'warn' | 'danger' }) {
  return <span className={`tone tone-${tone}`}>{value}</span>;
}

function formatBytes(bytes?: number) {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function summarizeRunnerResources(target: Target) {
  return target.localRunners.reduce((totals, runner) => ({
    cpuPercent: totals.cpuPercent + (runner.cpuPercent || 0),
    memoryBytes: totals.memoryBytes + (runner.memoryBytes || 0),
    diskBytes: totals.diskBytes + (runner.diskBytes || 0),
  }), {
    cpuPercent: 0,
    memoryBytes: 0,
    diskBytes: 0,
  });
}

function RunActions({
  targetId,
  run,
  busy,
  onBusyChange,
  onCancelRun,
  onStatusChange,
  onJobsLoaded,
}: {
  targetId: string;
  run: WorkflowRun;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onCancelRun: (runId: number) => Promise<void>;
  onStatusChange: (message: string) => void;
  onJobsLoaded: (jobs: WorkflowJob[]) => void;
}) {
  async function loadJobs() {
    onBusyChange(true);
    onStatusChange('Loading jobs...');
    try {
      const jobs = await api.getJobs(targetId, run.id);
      onJobsLoaded(jobs);
      onStatusChange('');
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  async function trigger(action: 'rerunRun' | 'rerunFailed') {
    onBusyChange(true);
    onStatusChange(action === 'rerunRun' ? 'Requesting run rerun...' : 'Requesting failed-job rerun...');
    try {
      if (action === 'rerunRun') await api.rerunRun(targetId, run.id);
      else await api.rerunFailed(targetId, run.id);
      onStatusChange(action === 'rerunRun' ? 'Rerun requested.' : 'Retry failed requested.');
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <div className="actions">
      <button type="button" onClick={() => void loadJobs()} disabled={busy}>Jobs</button>
      {run.status === 'completed' ? (
        <>
          <button type="button" onClick={() => void trigger('rerunRun')} disabled={busy}>Rerun</button>
          <button type="button" onClick={() => void trigger('rerunFailed')} disabled={busy}>Retry failed</button>
        </>
      ) : (
        <button type="button" className="danger" onClick={() => void onCancelRun(run.id)} disabled={busy}>Cancel</button>
      )}
    </div>
  );
}

export function TargetCard({ target, busy, onBusyChange, onStatusChange, onRefresh }: TargetCardProps) {
  const [jobs, setJobs] = useState<WorkflowJob[] | null>(null);

  const running = target.localRunners.filter((runner) => runner.state === 'running').length;
  const registered = target.githubRunners.length;
  const busyCount = target.githubRunners.filter((runner) => runner.busy).length;

  async function restartTarget() {
    onBusyChange(true);
    onStatusChange(`Restarting runners for ${target.id}...`);
    try {
      await api.restartTarget(target.id);
      await onRefresh();
      onStatusChange('Runners restarted and fleet status refreshed.');
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  async function removeTarget() {
    if (!window.confirm(`Remove target ${target.id} and stop its runners?`)) return;

    onBusyChange(true);
    onStatusChange('Removing target...');
    try {
      await api.removeTarget(target.id);
      await onRefresh();
      onStatusChange('Target removed.');
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  async function rerunJob(jobId: number) {
    onBusyChange(true);
    onStatusChange('Requesting job rerun...');
    try {
      await api.rerunJob(target.id, jobId);
      onStatusChange('Job rerun requested.');
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  async function cancelRun(runId: number) {
    onBusyChange(true);
    onStatusChange(`Canceling run ${runId}...`);
    try {
      await api.cancelRun(target.id, runId);
      onStatusChange(`Run ${runId} cancel requested.`);
      await onRefresh();
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  const resources = summarizeRunnerResources(target);

  return (
    <section className="card target-card">
      <div className="section-head">
        <div>
          <h2>{target.name}</h2>
          <div className="target-path">{target.repository}</div>
        </div>
        <div className="toolbar">
          <span className="scope-chip">{target.scope}</span>
          <button type="button" onClick={() => void restartTarget()} disabled={busy}>Restart runners</button>
          <button type="button" className="danger" onClick={() => void removeTarget()} disabled={busy}>Remove target</button>
        </div>
      </div>
      {target.description ? <p className="muted compact">{target.description}</p> : null}
      <div className="summary-strip">
        <div>
          <span className="summary-label">Runners</span>
          <strong>{running}/{target.runnersCount}</strong>
        </div>
        <div>
          <span className="summary-label">Registered</span>
          <strong>{registered}</strong>
        </div>
        <div>
          <span className="summary-label">Busy</span>
          <strong>{busyCount}</strong>
        </div>
        <div>
          <span className="summary-label">CPU</span>
          <strong>{resources.cpuPercent ? `${resources.cpuPercent.toFixed(1)}%` : '-'}</strong>
        </div>
        <div>
          <span className="summary-label">Memory</span>
          <strong>{formatBytes(resources.memoryBytes)}</strong>
        </div>
        <div>
          <span className="summary-label">Disk</span>
          <strong>{formatBytes(resources.diskBytes)}</strong>
        </div>
        <div>
          <span className="summary-label">Labels</span>
          <div><LabelList labels={target.labels} /></div>
        </div>
      </div>

      <div className="panel-grid">
        <section className="subcard">
          <h3>Local Runner Containers</h3>
          <table>
            <thead>
              <tr><th>Container</th><th>State</th><th>Status</th><th>CPU</th><th>Memory</th><th>Disk</th><th>Image</th></tr>
            </thead>
            <tbody>
              {target.localRunners.length ? target.localRunners.map((runner) => (
                <tr key={runner.name}>
                  <td><code>{runner.name}</code></td>
                  <td><Tone value={runner.state} tone={runner.state === 'running' ? 'ok' : 'danger'} /></td>
                  <td>{runner.status}</td>
                  <td>{runner.cpuPercent ? `${runner.cpuPercent.toFixed(1)}%` : '-'}</td>
                  <td>{formatBytes(runner.memoryBytes)}</td>
                  <td>{formatBytes(runner.diskBytes)}</td>
                  <td>{runner.image || '-'}</td>
                </tr>
              )) : (
                <tr><td colSpan={7}>No runners configured.</td></tr>
              )}
            </tbody>
          </table>
        </section>
        <section className="subcard">
          <h3>Registered in GitHub</h3>
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Busy</th><th>OS</th><th>Labels</th></tr>
            </thead>
            <tbody>
              {target.githubRunners.length ? target.githubRunners.map((runner) => (
                <tr key={runner.id}>
                  <td><code>{runner.name}</code></td>
                  <td>{runner.status}</td>
                  <td><Tone value={runner.busy ? 'busy' : 'idle'} tone={runner.busy ? 'warn' : 'ok'} /></td>
                  <td>{runner.os || '-'}</td>
                  <td><LabelList labels={runner.labels} /></td>
                </tr>
              )) : (
                <tr><td colSpan={5}>No registered runners in GitHub.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      <div className="panel-grid single-column">
        <section className="subcard">
          <div className="section-head section-head-tight">
            <h3>Run Feed</h3>
            <span className="muted">{target.repo ? target.repository : 'no repo configured'}</span>
          </div>
          <table>
            <thead>
              <tr><th>Run</th><th>Event</th><th>Status</th><th>Conclusion</th><th>Created</th><th>Action</th></tr>
            </thead>
            <tbody>
              {!target.repo ? (
                <tr><td colSpan={6}>Configure a repo to see run history.</td></tr>
              ) : !target.latestRuns.length ? (
                <tr><td colSpan={6}>No recent runs.</td></tr>
              ) : target.latestRuns.map((run) => (
                <tr key={run.id}>
                  <td><a href={run.url} target="_blank" rel="noreferrer">{run.id}</a></td>
                  <td>{run.event}</td>
                  <td>{run.status}</td>
                  <td>{run.conclusion || '-'}</td>
                  <td>{run.created_at}</td>
                  <td>
                    <RunActions
                      targetId={target.id}
                      run={run}
                      busy={busy}
                      onBusyChange={onBusyChange}
                      onCancelRun={cancelRun}
                      onStatusChange={onStatusChange}
                      onJobsLoaded={setJobs}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="jobs-panel">
            {jobs === null ? (
              <span className="muted">Select a run to see jobs.</span>
            ) : jobs.length ? (
              <table>
                <thead>
                  <tr><th>Job</th><th>Status</th><th>Conclusion</th><th>Runner</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td><a href={job.html_url} target="_blank" rel="noreferrer">{job.name}</a></td>
                      <td>{job.status}</td>
                      <td>{job.conclusion || '-'}</td>
                      <td>{job.runner_name || '-'}</td>
                      <td><button type="button" onClick={() => void rerunJob(job.id)} disabled={busy}>Rerun</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              'No jobs found.'
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

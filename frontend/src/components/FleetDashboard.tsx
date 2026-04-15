import type { FleetStatus, Target } from '../types';
import { api } from '../lib/api';

type FleetDashboardProps = {
  status: FleetStatus;
  activeTargetId: string;
  onSelectTarget: (targetId: string) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (message: string) => void;
};

function formatRunnerCoverage(target: Target) {
  const running = target.localRunners.filter((runner) => runner.state === 'running').length;
  return `${running}/${target.runnersCount}`;
}

function formatGithubAvailability(target: Target) {
  const online = target.githubRunners.filter((runner) => runner.status === 'online').length;
  return `${online}/${target.githubRunners.length}`;
}

function resolveHealth(target: Target) {
  const running = target.localRunners.filter((runner) => runner.state === 'running').length;
  const online = target.githubRunners.filter((runner) => runner.status === 'online').length;

  if (running === target.runnersCount && online >= Math.min(target.runnersCount, 1)) {
    return { label: 'healthy', tone: 'ok' as const };
  }

  if (running > 0 || online > 0) {
    return { label: 'degraded', tone: 'warn' as const };
  }

  return { label: 'down', tone: 'danger' as const };
}

function resolveRunState(target: Target) {
  const inProgressRuns = target.activeRuns.filter((run) => run.status === 'in_progress');
  if (inProgressRuns.length) {
    return `${inProgressRuns.length} active job${inProgressRuns.length === 1 ? '' : 's'}`;
  }

  const queuedRuns = target.activeRuns.filter((run) => run.status === 'queued');
  if (queuedRuns.length) {
    return `${queuedRuns.length} queued run${queuedRuns.length === 1 ? '' : 's'}`;
  }

  const latestRun = target.latestRuns[0];
  if (!latestRun) {
    return target.repo ? 'No recent jobs' : 'No repo feed';
  }

  if (latestRun.status !== 'completed') {
    return `${latestRun.name} is ${latestRun.status}`;
  }

  return `${latestRun.name}: ${latestRun.conclusion || 'completed'}`;
}

function sumRunnerMetric(target: Target, key: 'cpuPercent' | 'memoryBytes' | 'diskBytes') {
  return target.localRunners.reduce((total, runner) => total + (runner[key] || 0), 0);
}

function formatBytes(bytes: number) {
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

function formatCpu(target: Target) {
  const cpu = sumRunnerMetric(target, 'cpuPercent');
  return cpu ? `${cpu.toFixed(1)}%` : '-';
}

function formatMemory(target: Target) {
  return formatBytes(sumRunnerMetric(target, 'memoryBytes'));
}

function formatDisk(target: Target) {
  return formatBytes(sumRunnerMetric(target, 'diskBytes'));
}

export function FleetDashboard({ status, activeTargetId, onSelectTarget, busy, onBusyChange, onStatusChange }: FleetDashboardProps) {
  async function cancelRun(targetId: string, runId: number) {
    onBusyChange(true);
    onStatusChange(`Canceling run ${runId}...`);
    try {
      await api.cancelRun(targetId, runId);
      onStatusChange(`Run ${runId} cancel requested.`);
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <section className="dashboard-grid">
      <section className="card summary-table-card">
        <div className="section-head section-head-tight">
          <div>
            <h2>Fleet overview</h2>
            <p className="muted compact">One row per target, focused on health, capacity and current job pressure.</p>
          </div>
          <div className="toolbar">
            <span className="muted">Updated <code>{status.generatedAt}</code></span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Scope</th>
              <th>Health</th>
              <th>Local</th>
              <th>GitHub</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Disk</th>
              <th>Jobs</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {status.targets.map((target) => {
              const health = resolveHealth(target);
              const cancellableRun = target.activeRuns.find((run) => run.status === 'in_progress');
              return (
                <tr key={target.id}>
                  <td>
                    <div className="stack-cell">
                      <strong>{target.name}</strong>
                      <span className="muted">{target.repository}</span>
                    </div>
                  </td>
                  <td><span className="scope-chip">{target.scope}</span></td>
                  <td><span className={`tone tone-${health.tone}`}>{health.label}</span></td>
                  <td>{formatRunnerCoverage(target)}</td>
                  <td>{formatGithubAvailability(target)}</td>
                  <td>{formatCpu(target)}</td>
                  <td>{formatMemory(target)}</td>
                  <td>{formatDisk(target)}</td>
                  <td>{resolveRunState(target)}</td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        className={activeTargetId === target.id ? 'accent' : ''}
                        onClick={() => onSelectTarget(target.id)}
                      >
                        Open
                      </button>
                      {cancellableRun ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() => void cancelRun(target.id, cancellableRun.id)}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="dashboard-health-grid">
        {status.targets.map((target) => {
          const running = target.localRunners.filter((runner) => runner.state === 'running').length;
          const busy = target.githubRunners.filter((runner) => runner.busy).length;
          const health = resolveHealth(target);

          return (
            <button
              key={target.id}
              type="button"
              className={`health-card ${activeTargetId === target.id ? 'health-card-active' : ''}`}
              onClick={() => onSelectTarget(target.id)}
            >
              <div className="health-card-top">
                <strong>{target.name}</strong>
                <span className={`tone tone-${health.tone}`}>{health.label}</span>
              </div>
              <div className="health-card-meta">{target.repository}</div>
              <div className="health-card-stats">
                <span>Local {running}/{target.runnersCount}</span>
                <span>Busy {busy}</span>
                <span>CPU {formatCpu(target)}</span>
                <span>Mem {formatMemory(target)}</span>
                <span>Disk {formatDisk(target)}</span>
                <span>{resolveRunState(target)}</span>
              </div>
            </button>
          );
        })}
      </section>
    </section>
  );
}

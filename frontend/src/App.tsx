import { useEffect, useMemo, useState } from 'react';
import { AddTargetCard } from './components/AddTargetCard';
import { FleetDashboard } from './components/FleetDashboard';
import { Overview } from './components/Overview';
import { TargetCard } from './components/TargetCard';
import { api } from './lib/api';
import type { FleetStatus } from './types';

type TabKey = 'overview' | 'add' | `target:${string}`;

export function App() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  async function refreshStatus() {
    try {
      const nextStatus = await api.getStatus();
      setStatus(nextStatus);
      setError('');
      return nextStatus;
    } catch (nextError) {
      setError((nextError as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const intervalId = window.setInterval(() => {
      void refreshStatus();
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!status || !activeTab.startsWith('target:')) return;
    const targetId = activeTab.replace('target:', '');
    if (!status.targets.some((target) => target.id === targetId)) {
      setActiveTab(status.targets[0] ? `target:${status.targets[0].id}` : 'overview');
    }
  }, [activeTab, status]);

  const counts = useMemo(() => {
    if (!status) {
      return { runners: '0/0', registered: 0 };
    }

    const totalRunning = status.targets.reduce((sum, target) => sum + target.localRunners.filter((runner) => runner.state === 'running').length, 0);
    const totalConfigured = status.targets.reduce((sum, target) => sum + target.runnersCount, 0);
    const totalRegistered = status.targets.reduce((sum, target) => sum + target.githubRunners.length, 0);

    return {
      runners: `${totalRunning}/${totalConfigured}`,
      registered: totalRegistered,
    };
  }, [status]);

  const activeTargetId = useMemo(() => {
    if (!status?.targets.length) return '';
    if (!activeTab.startsWith('target:')) return status.targets[0].id;
    const targetId = activeTab.replace('target:', '');
    return status.targets.some((target) => target.id === targetId) ? targetId : status.targets[0].id;
  }, [activeTab, status]);

  const activeTarget = status?.targets.find((target) => target.id === activeTargetId) || null;

  async function refreshStatusAndFocusNewTarget() {
    const nextStatus = await refreshStatus();
    if (!nextStatus?.targets.length) {
      setActiveTab('overview');
      return;
    }

    const currentIds = new Set(status?.targets.map((target) => target.id) || []);
    const newTarget = nextStatus.targets.find((target) => !currentIds.has(target.id));
    setActiveTab(newTarget ? `target:${newTarget.id}` : `target:${nextStatus.targets[0].id}`);
  }

  return (
    <main>
      <Overview
        targets={status?.targets.length || 0}
        runners={counts.runners}
        registered={counts.registered}
        generatedAt={status?.generatedAt || 'loading...'}
        actionStatus={error || actionStatus}
      />

      {loading && !status ? <section className="card">Loading fleet status...</section> : null}

      {status ? (
        <>
          <nav className="tabs" aria-label="Fleet views">
            <button
              type="button"
              className={`tab ${activeTab === 'overview' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            {status.targets.map((target) => (
              <button
                key={target.id}
                type="button"
                className={`tab ${activeTab === `target:${target.id}` ? 'tab-active' : ''}`}
                onClick={() => setActiveTab(`target:${target.id}`)}
              >
                {target.name}
              </button>
            ))}
            <button
              type="button"
              className={`tab tab-add ${activeTab === 'add' ? 'tab-active' : ''}`}
              onClick={() => setActiveTab('add')}
              aria-label="Add target"
            >
              +
            </button>
          </nav>

          {activeTab === 'overview' ? (
            <FleetDashboard
              status={status}
              activeTargetId={activeTargetId}
              onSelectTarget={(targetId) => setActiveTab(`target:${targetId}`)}
            />
          ) : null}

          {activeTab === 'add' ? (
            <AddTargetCard
              targets={status.targets}
              busy={busy}
              onBusyChange={setBusy}
              onStatusChange={setActionStatus}
              onSubmitted={refreshStatusAndFocusNewTarget}
            />
          ) : null}

          {activeTab.startsWith('target:') && activeTarget ? (
            <TargetCard
              target={activeTarget}
              busy={busy}
              onBusyChange={setBusy}
              onStatusChange={setActionStatus}
              onRefresh={async () => {
                await refreshStatus();
              }}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

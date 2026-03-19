import { useEffect, useMemo, useState } from 'react';
import { AddTargetCard } from './components/AddTargetCard';
import { Overview } from './components/Overview';
import { TargetCard } from './components/TargetCard';
import { api } from './lib/api';
import type { FleetStatus } from './types';

export function App() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const [error, setError] = useState('');

  async function refreshStatus() {
    try {
      const nextStatus = await api.getStatus();
      setStatus(nextStatus);
      setError('');
    } catch (nextError) {
      setError((nextError as Error).message);
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
          <AddTargetCard
            targets={status.targets}
            busy={busy}
            onBusyChange={setBusy}
            onStatusChange={setActionStatus}
            onSubmitted={refreshStatus}
          />
          {status.targets.map((target) => (
            <TargetCard
              key={target.id}
              target={target}
              busy={busy}
              onBusyChange={setBusy}
              onStatusChange={setActionStatus}
              onRefresh={refreshStatus}
            />
          ))}
        </>
      ) : null}
    </main>
  );
}

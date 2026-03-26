type OverviewProps = {
  targets: number;
  runners: string;
  registered: number;
  generatedAt: string;
  actionStatus: string;
};

export function Overview({ targets, runners, registered, generatedAt, actionStatus }: OverviewProps) {
  return (
    <section className="overview">
      <section className="card page-head">
        <h1>GitHub Runner Fleet</h1>
        <p className="muted">
          Persistent self-hosted runners with isolated Docker-in-Docker daemons. Runners stay connected to GitHub;
          job containers are ephemeral.
        </p>
        <p className="muted">
          Updated <code>{generatedAt}</code>
        </p>
        <p className="muted status-line">{actionStatus}</p>
      </section>
      <section className="metric">
        <span>Targets</span>
        <strong>{targets}</strong>
      </section>
      <section className="metric">
        <span>Runners</span>
        <strong>{runners}</strong>
      </section>
      <section className="metric">
        <span>Registered</span>
        <strong>{registered}</strong>
      </section>
    </section>
  );
}

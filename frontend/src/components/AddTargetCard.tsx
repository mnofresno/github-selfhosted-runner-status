import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { Target, TargetFormPayload } from '../types';

const slugPattern = /^[A-Za-z0-9_.-]+$/;

type FormState = {
  name: string;
  scope: 'org' | 'repo';
  lookupTargetId: string;
  owner: string;
  repo: string;
  labels: string;
  runnersCount: string;
  runnerGroup: string;
  description: string;
};

type AddTargetCardProps = {
  targets: Target[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onStatusChange: (message: string) => void;
  onSubmitted: () => Promise<void>;
};

function validateField(value: string, required: boolean) {
  const trimmed = value.trim();
  if (!trimmed) return required ? 'This field is required.' : '';
  return slugPattern.test(trimmed) ? '' : 'Only letters, numbers, ".", "_" and "-" are allowed.';
}

export function AddTargetCard({ targets, busy, onBusyChange, onStatusChange, onSubmitted }: AddTargetCardProps) {
  const [form, setForm] = useState<FormState>({
    name: '',
    scope: 'org',
    lookupTargetId: '',
    owner: '',
    repo: '',
    labels: 'self-hosted,linux,x64',
    runnersCount: '1',
    runnerGroup: '',
    description: '',
  });
  const [ownerOptions, setOwnerOptions] = useState<string[]>([]);
  const [repoOptions, setRepoOptions] = useState<string[]>([]);
  const [ownerError, setOwnerError] = useState('');
  const [repoError, setRepoError] = useState('');

  const repoRequired = form.scope === 'repo';
  const lookupTargets = useMemo(
    () => [{ id: '', label: 'Default ACCESS_TOKEN' }, ...targets.map((target) => ({ id: target.id, label: `${target.name} (${target.owner})` }))],
    [targets],
  );

  useEffect(() => {
    if (!form.owner.trim()) {
      setRepoOptions([]);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      api.getRepos(form.lookupTargetId, form.owner.trim(), form.repo)
        .then(setRepoOptions)
        .catch((error: Error) => onStatusChange(`Autocomplete failed: ${error.message}`));
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [form.lookupTargetId, form.owner, form.repo, onStatusChange]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      api.getOwners(form.lookupTargetId, form.owner)
        .then(setOwnerOptions)
        .catch((error: Error) => onStatusChange(`Autocomplete failed: ${error.message}`));
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [form.lookupTargetId, form.owner, onStatusChange]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === 'scope' && value === 'org' ? { repo: '' } : {}),
    }));
  }

  async function refreshOwners() {
    onStatusChange('Loading owner suggestions...');
    const owners = await api.getOwners(form.lookupTargetId, form.owner);
    setOwnerOptions(owners);
    onStatusChange('Owner suggestions updated.');
  }

  async function refreshRepos() {
    if (!form.owner.trim()) {
      onStatusChange('Owner / Org is required before loading repositories.');
      return;
    }
    onStatusChange('Loading repository suggestions...');
    const repos = await api.getRepos(form.lookupTargetId, form.owner.trim(), form.repo);
    setRepoOptions(repos);
    onStatusChange('Repository suggestions updated.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextOwnerError = validateField(form.owner, true);
    const nextRepoError = repoRequired ? validateField(form.repo, true) : '';
    setOwnerError(nextOwnerError);
    setRepoError(nextRepoError);

    if (nextOwnerError || nextRepoError) {
      onStatusChange('Fix the highlighted fields before adding the target.');
      return;
    }

    onBusyChange(true);
    onStatusChange('Adding target...');

    try {
      const payload: TargetFormPayload = {
        name: form.name.trim(),
        scope: form.scope,
        owner: form.owner.trim(),
        repo: form.repo.trim() || undefined,
        labels: form.labels.trim(),
        runnersCount: Number(form.runnersCount),
        runnerGroup: form.runnerGroup.trim() || undefined,
        description: form.description.trim() || undefined,
      };

      await api.addTarget(payload);
      setForm((current) => ({
        ...current,
        name: '',
        owner: '',
        repo: '',
        runnerGroup: '',
        description: '',
      }));
      setOwnerOptions([]);
      setRepoOptions([]);
      onStatusChange('Target added. Refreshing fleet status...');
      await onSubmitted();
    } catch (error) {
      onStatusChange(`Failed: ${(error as Error).message}`);
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <section className="card">
      <div className="section-head section-head-tight">
        <h2>Add Target</h2>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="target-name">Name</label>
            <input id="target-name" value={form.name} onChange={(event) => updateField('name', event.target.value)} required placeholder="e.g. My Org Fleet" />
          </div>
          <div className="form-field">
            <label htmlFor="target-scope">Scope</label>
            <select id="target-scope" value={form.scope} onChange={(event) => updateField('scope', event.target.value as FormState['scope'])}>
              <option value="org">Organization</option>
              <option value="repo">Repository</option>
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="lookup-target">Lookup Token</label>
            <select id="lookup-target" value={form.lookupTargetId} onChange={(event) => updateField('lookupTargetId', event.target.value)}>
              {lookupTargets.map((option) => (
                <option key={option.id || 'default'} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="field-note">Uses the default token or one from an existing target to fetch suggestions.</div>
          </div>
          <div className="form-field">
            <label htmlFor="target-owner">Owner / Org</label>
            <div className="input-with-button">
              <input
                id="target-owner"
                value={form.owner}
                onChange={(event) => {
                  updateField('owner', event.target.value);
                  setOwnerError(validateField(event.target.value, true));
                }}
                list="owner-suggestions"
                required
                autoComplete="off"
                spellCheck={false}
                className={ownerError ? 'input-invalid' : ''}
                placeholder="e.g. my-org"
              />
              <button type="button" onClick={() => void refreshOwners()} disabled={busy}>Suggest</button>
            </div>
            <datalist id="owner-suggestions">
              {ownerOptions.map((owner) => <option key={owner} value={owner} />)}
            </datalist>
            <div className="field-note">Start typing or fetch suggestions from GitHub owners and orgs you can access.</div>
            <div className="field-error">{ownerError}</div>
          </div>
          <div className="form-field">
            <label htmlFor="target-repo">Repository (for run feed)</label>
            <div className="input-with-button">
              <input
                id="target-repo"
                value={form.repo}
                onChange={(event) => {
                  updateField('repo', event.target.value);
                  setRepoError(repoRequired ? validateField(event.target.value, true) : '');
                }}
                list="repo-suggestions"
                autoComplete="off"
                spellCheck={false}
                className={repoError ? 'input-invalid' : ''}
                placeholder="e.g. my-app"
                disabled={!repoRequired}
              />
              <button type="button" onClick={() => void refreshRepos()} disabled={busy || !form.owner.trim()}>Suggest</button>
            </div>
            <datalist id="repo-suggestions">
              {repoOptions.map((repo) => <option key={repo} value={repo} />)}
            </datalist>
            <div className="field-note">
              {repoRequired
                ? 'Required for repository targets. Suggestions depend on the selected owner.'
                : 'Optional for org targets. Add one if you want a run feed on the dashboard.'}
            </div>
            <div className="field-error">{repoError}</div>
          </div>
          <div className="form-field">
            <label htmlFor="target-labels">Labels</label>
            <input id="target-labels" value={form.labels} onChange={(event) => updateField('labels', event.target.value)} placeholder="comma-separated" />
          </div>
          <div className="form-field">
            <label htmlFor="target-runners">Runners Count</label>
            <input id="target-runners" value={form.runnersCount} onChange={(event) => updateField('runnersCount', event.target.value)} type="number" min="1" max="5" />
          </div>
          <div className="form-field">
            <label htmlFor="target-group">Runner Group</label>
            <input id="target-group" value={form.runnerGroup} onChange={(event) => updateField('runnerGroup', event.target.value)} placeholder="Default" />
          </div>
          <div className="form-field">
            <label htmlFor="target-description">Description</label>
            <input id="target-description" value={form.description} onChange={(event) => updateField('description', event.target.value)} placeholder="optional" />
          </div>
          <div className="form-field full form-actions">
            <button type="submit" className="accent" disabled={busy}>Add and Start Runners</button>
          </div>
        </div>
      </form>
    </section>
  );
}

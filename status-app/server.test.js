const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRunnerContainerSpec,
  loadTargets,
  parseListenPort,
  parseRepoUrl,
} = require('./server');

test('parseRepoUrl extracts owner and repo', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/bpf-project/bpf-application.git'), {
    owner: 'bpf-project',
    repo: 'bpf-application',
  });
});

test('loadTargets supports repo and org targets with default token fallback', () => {
  const targets = loadTargets({
    ACCESS_TOKEN: 'top-secret',
    RUNNER_IMAGE: 'myoung34/github-runner:latest',
    RUNNER_WORKDIR: '/tmp/github-runner',
    LABELS: 'self-hosted,linux',
    RUNNER_TARGETS_JSON: JSON.stringify([
      {
        id: 'bpf-app',
        scope: 'repo',
        owner: 'bpf-project',
        repo: 'bpf-application',
      },
      {
        id: 'gymnerd-org',
        scope: 'org',
        owner: 'gymnerd-ar',
        labels: ['self-hosted', 'gymnerd'],
      },
    ]),
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[0].repoUrl, 'https://github.com/bpf-project/bpf-application');
  assert.equal(targets[1].scope, 'org');
  assert.equal(targets[1].accessToken, 'top-secret');
  assert.deepEqual(targets[1].labels, ['self-hosted', 'gymnerd']);
});

test('buildRunnerContainerSpec creates isolated ephemeral runner payload', () => {
  const target = {
    id: 'gymnerd-bot',
    scope: 'repo',
    owner: 'gymnerd-ar',
    repo: 'gymnerd-bot',
    repoUrl: 'https://github.com/gymnerd-ar/gymnerd-bot',
    accessToken: 'token',
    labels: ['self-hosted', 'linux', 'x64', 'gymnerd'],
    runnerImage: 'myoung34/github-runner:latest',
    runnerWorkdir: '/tmp/github-runner',
    runnerGroup: '',
  };

  const spec = buildRunnerContainerSpec(target, 'gymnerd-bot-runner-20260312');

  assert.match(spec.volumeName, /^ghrunner-gymnerd-bot-/);
  assert.ok(spec.body.Env.includes('RUNNER_SCOPE=repo'));
  assert.ok(spec.body.Env.includes('EPHEMERAL=true'));
  assert.ok(spec.body.Env.includes('REPO_URL=https://github.com/gymnerd-ar/gymnerd-bot'));
  assert.ok(spec.body.HostConfig.Binds.includes('/var/run/docker.sock:/var/run/docker.sock'));
  assert.ok(spec.body.HostConfig.Binds.some((entry) => entry.endsWith(':/tmp/github-runner')));
});

test('parseListenPort ignores host bind strings and keeps internal default', () => {
  assert.equal(parseListenPort('3571'), 3571);
  assert.equal(parseListenPort('127.0.0.1:3571'), 8080);
  assert.equal(parseListenPort(''), 8080);
});

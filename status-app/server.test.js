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
        repo: 'gymnerd-bot',
        labels: ['self-hosted', 'gymnerd'],
      },
    ]),
  });

  assert.equal(targets.length, 2);
  assert.equal(targets[0].repoUrl, 'https://github.com/bpf-project/bpf-application');
  assert.equal(targets[1].scope, 'org');
  assert.equal(targets[1].repo, 'gymnerd-bot');
  assert.equal(targets[1].repoUrl, 'https://github.com/gymnerd-ar/gymnerd-bot');
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
    dindImage: 'docker:27-dind',
    runnerGroup: '',
  };

  const spec = buildRunnerContainerSpec(target, 'gymnerd-bot-runner-20260312');

  assert.match(spec.runnerVolumeName, /^ghrunner-work-gymnerd-bot-/);
  assert.match(spec.dockerVolumeName, /^ghrunner-docker-gymnerd-bot-/);
  assert.match(spec.networkName, /^ghrunner-net-gymnerd-bot-/);
  assert.ok(spec.runnerBody.Env.includes('RUNNER_SCOPE=repo'));
  assert.ok(spec.runnerBody.Env.includes('EPHEMERAL=true'));
  assert.ok(spec.runnerBody.Env.includes('REPO_URL=https://github.com/gymnerd-ar/gymnerd-bot'));
  assert.ok(spec.runnerBody.Env.includes('DOCKER_HOST=tcp://127.0.0.1:2375'));
  assert.ok(spec.runnerBody.HostConfig.Binds.some((entry) => entry.endsWith(':/tmp/github-runner')));
  assert.match(spec.runnerBody.HostConfig.NetworkMode, /^container:docker-gymnerd-bot-/);
  assert.equal(spec.runnerBody.Labels['io.github-runner-fleet.role'], 'runner');
  assert.equal(spec.dindBody.Image, 'docker:27-dind');
  assert.equal(spec.dindBody.HostConfig.Privileged, true);
  assert.deepEqual(spec.dindBody.Cmd, [
    'dockerd',
    '--host=tcp://127.0.0.1:2375',
    '--host=unix:///var/run/docker.sock',
    '--ip=127.0.0.1',
  ]);
  assert.ok(spec.dindBody.HostConfig.Binds.some((entry) => entry.endsWith(':/var/lib/docker')));
  assert.equal(spec.dindBody.Labels['io.github-runner-fleet.role'], 'dind');
});

test('parseListenPort ignores host bind strings and keeps internal default', () => {
  assert.equal(parseListenPort('3571'), 3571);
  assert.equal(parseListenPort('127.0.0.1:3571'), 8080);
  assert.equal(parseListenPort(''), 8080);
});

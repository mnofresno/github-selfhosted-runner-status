export type RunnerState = {
  id?: string;
  name: string;
  state: string;
  status: string;
  image?: string;
  created?: number;
};

export type GithubRunner = {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels: string[];
  os?: string;
};

export type WorkflowRun = {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  created_at: string;
};

export type WorkflowJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runner_name: string | null;
  html_url: string;
};

export type Target = {
  id: string;
  name: string;
  scope: 'org' | 'repo';
  owner: string;
  repo?: string;
  repository: string;
  labels: string[];
  runnersCount: number;
  runnerGroup?: string;
  description?: string;
  localRunners: RunnerState[];
  githubRunners: GithubRunner[];
  latestRuns: WorkflowRun[];
  activeRuns: WorkflowRun[];
};

export type FleetStatus = {
  generatedAt: string;
  targets: Target[];
};

export type TargetFormPayload = {
  name: string;
  scope: 'org' | 'repo';
  owner: string;
  repo?: string;
  labels: string;
  runnersCount: number;
  runnerGroup?: string;
  description?: string;
};

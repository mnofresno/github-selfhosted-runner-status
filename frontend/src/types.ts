export type RunnerState = {
  id?: string;
  name: string;
  state: string;
  status: string;
  image?: string;
  created?: number;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  diskBytes?: number;
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

export type CleanupStackSummary = {
  stackId: string;
  targetId: string;
  runnerName: string;
  createdMs: number;
  ageMs: number;
  targetConfigured: boolean;
  containerIds: string[];
  volumeNames: string[];
  networkNames: string[];
  labelCompleteness: {
    managed: boolean;
    targetId: boolean;
    runnerName: boolean;
    stackId: boolean;
  };
};

export type CleanupResourceSummary = {
  type: 'container' | 'volume' | 'network';
  id: string;
  reason: string;
};

export type CleanupRunResult = {
  mode: 'fleet' | 'global';
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
  skipped?: boolean;
  reason?: string;
  plan?: {
    staleManagedStacks: CleanupStackSummary[];
    ignoredResources: CleanupResourceSummary[];
  };
  removedStacks?: CleanupStackSummary[];
  pruneResult?: unknown;
  reconciledTargets?: Array<{
    targetId: string;
    results: unknown;
  }>;
  statusAtRun?: unknown;
  errors?: Array<{
    stackId?: string;
    targetId?: string;
    scope?: string;
    error: string;
  }>;
  error?: string;
};

export type CleanupState = {
  running: boolean;
  lastRunAt: string | null;
  lastStartedAt: string | null;
  lastResult: CleanupRunResult | null;
  lastError: string | null;
};

export type CleanupStatus = {
  maintenanceRunning: boolean;
  fleet: CleanupState;
  global: CleanupState;
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

export type TargetUpdatePayload = {
  runnersCount: number;
};

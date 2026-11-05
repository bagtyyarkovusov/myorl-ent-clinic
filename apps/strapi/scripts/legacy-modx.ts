import { execFileSync } from 'node:child_process';
import path from 'node:path';

const COMPOSE_FILE = path.resolve(__dirname, '..', '..', '..', 'infra', 'legacy-modx', 'docker-compose.yml');
const CONTAINER_NAME = 'legacy-modx-mysql';
const HEALTH_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_POLL_MS = 2 * 1000;

function runDockerCompose(args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
  });
}

function getContainerHealth(): 'healthy' | 'starting' | 'unhealthy' | null {
  try {
    const output = execFileSync(
      'docker',
      ['inspect', '--format', '{{json .State.Health.Status}}', CONTAINER_NAME],
      { encoding: 'utf8' },
    ).trim();
    return output ? (JSON.parse(output) as 'healthy' | 'starting' | 'unhealthy') : null;
  } catch {
    return null;
  }
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const health = getContainerHealth();
    if (health === 'healthy') {
      console.error(`[legacy-modx] ${CONTAINER_NAME} is healthy`);
      return;
    }

    console.error(`[legacy-modx] waiting for ${CONTAINER_NAME} health${health ? ` (${health})` : ''}...`);
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }

  throw new Error(
    `[legacy-modx] timed out waiting for ${CONTAINER_NAME} to become healthy after ${HEALTH_TIMEOUT_MS / 1000}s`,
  );
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command !== 'up' && command !== 'down') {
    throw new Error('usage: tsx scripts/legacy-modx.ts <up|down>');
  }

  if (command === 'up') {
    runDockerCompose(['up', '-d']);
    await waitForHealthy();
    return;
  }

  runDockerCompose(['down']);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[legacy-modx] FATAL:', err);
    process.exit(1);
  });
}

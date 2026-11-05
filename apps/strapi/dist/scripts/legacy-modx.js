"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const COMPOSE_FILE = node_path_1.default.resolve(__dirname, '..', '..', '..', 'infra', 'legacy-modx', 'docker-compose.yml');
const CONTAINER_NAME = 'legacy-modx-mysql';
const HEALTH_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_POLL_MS = 2 * 1000;
function runDockerCompose(args) {
    (0, node_child_process_1.execFileSync)('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
        stdio: 'inherit',
    });
}
function getContainerHealth() {
    try {
        const output = (0, node_child_process_1.execFileSync)('docker', ['inspect', '--format', '{{json .State.Health.Status}}', CONTAINER_NAME], { encoding: 'utf8' }).trim();
        return output ? JSON.parse(output) : null;
    }
    catch {
        return null;
    }
}
async function waitForHealthy() {
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
    throw new Error(`[legacy-modx] timed out waiting for ${CONTAINER_NAME} to become healthy after ${HEALTH_TIMEOUT_MS / 1000}s`);
}
async function main(argv = process.argv.slice(2)) {
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

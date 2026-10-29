import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Shared e2e paths: temp data dir (unique per machine), setup-token reader. */
export const E2E_DATA_DIR = resolve(tmpdir(), 'zcode-bot-e2e-data');
export const E2E_PORT = 8791;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, 'src/nodes/PromptScrub/prompt-scrub.svg');
const destination = resolve(packageRoot, 'dist/nodes/PromptScrub/prompt-scrub.svg');

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

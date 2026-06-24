#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setupScrubCommand } from './commands/scrub.js';
import { setupRehydrateCommand } from './commands/rehydrate.js';
import { setupInspectCommand } from './commands/inspect.js';
import { setupSessionsCommands } from './commands/sessions.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Depending on whether we run from src or dist, package.json might be up 2 or 3 levels.
// Easiest is just checking both or requiring it dynamically. Wait, standard ESM trick:
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
} catch {
  pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
}

const program = new Command();

program
  .name('prompt-scrub')
  .description('A local-first utility to strip identifying content out of prompts')
  .version(pkg.version || '1.0.0');

setupScrubCommand(program);
setupRehydrateCommand(program);
setupInspectCommand(program);
setupSessionsCommands(program);

program.parse(process.argv);

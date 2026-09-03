#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { setupConfigCommands } from './commands/config.js';
import { setupDiffCommand } from './commands/diff.js';
import { setupInspectCommand } from './commands/inspect.js';
import { setupRehydrateCommand } from './commands/rehydrate.js';
import { setupRulesCommands } from './commands/rules.js';
import { setupScrubCommand } from './commands/scrub.js';
import { setupSessionsCommands } from './commands/sessions.js';
import { setupWatchCommand } from './commands/watch.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export function getVersion(currentDir: string): string {
  let pkg: { version?: string };
  try {
    pkg = JSON.parse(readFileSync(join(currentDir, '..', '..', 'package.json'), 'utf8'));
  } catch {
    try {
      pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8'));
    } catch {
      pkg = {};
    }
  }
  return pkg.version || '1.0.0';
}

const program = new Command();

program
  .name('prompt-scrub')
  .description('A local-first utility to strip identifying content out of prompts')
  .version(getVersion(__dirname));

setupScrubCommand(program);
setupRehydrateCommand(program);
setupInspectCommand(program);
setupDiffCommand(program);
setupSessionsCommands(program);
setupRulesCommands(program);
setupConfigCommands(program);
setupWatchCommand(program);

if (process.argv[1] === __filename) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { rehydrate } from '../../core/rehydrate.js';
import { emitError } from '../output.js';

export function handleRehydrate(text: string, options: { sessionId: string }) {
  const result = rehydrate({
    content: text,
    sessionId: options.sessionId,
  });
  return result;
}

export function setupRehydrateCommand(program: Command) {
  program
    .command('rehydrate')
    .description('Rehydrate a file using stored session')
    .argument('[file]', 'File to rehydrate. If omitted, reads from stdin.')
    .requiredOption('--session-id <id>', 'Resume or target a specific session')
    .option('--json', 'Output a structured JSON object instead of plain text')
    .action((file, options) => {
      let input = '';

      if (file) {
        try {
          input = readFileSync(file, 'utf8');
        } catch (err: unknown) {
          const message = `Error reading file: ${(err as Error).message}`;
          emitError(message, options.json);
          process.exit(1);
          return;
        }
      } else {
        try {
          input = readFileSync(0, 'utf-8');
        } catch {
          const message = 'No input provided.';
          emitError(message, options.json);
          process.exit(1);
          return;
        }
      }
      if (!input) {
        if (options.json) {
          const output = {
            content: '',
            sessionId: options.sessionId,
            warnings: [],
          };
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        }
        process.exit(0);
        return;
      }

      const result = handleRehydrate(input, options);

      if (options.json) {
        const output = {
          content: result.content,
          sessionId: options.sessionId,
          warnings: result.warnings ?? [],
        };
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }

      // Print rehydrated content to stdout
      const outStr =
        typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content, null, 2);
      process.stdout.write(outStr);

      // Print any warnings to stderr
      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.error(warning);
        }
      }
    });
}

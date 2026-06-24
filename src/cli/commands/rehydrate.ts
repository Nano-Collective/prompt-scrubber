import { Command } from 'commander';
import { readFileSync } from 'fs';
import { rehydrate } from '../../core/rehydrate.js';

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
    .action((file, options) => {
      let input = '';

      if (file) {
        try {
          input = readFileSync(file, 'utf8');
        } catch (err: unknown) {
          console.error(`Error reading file: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        // Read from stdin
        try {
          input = readFileSync(0, 'utf-8');
        } catch {
          console.error('No input provided.');
          process.exit(1);
        }
      }

      if (!input) {
        console.error('No input provided.');
        process.exit(1);
      }

      const result = handleRehydrate(input, options);

      // Print rehydrated content to stdout
      process.stdout.write(result.content);

      // Print any warnings to stderr
      if (result.warnings && result.warnings.length > 0) {
        process.stderr.write('\n');
        for (const warning of result.warnings) {
          process.stderr.write(`${warning}\n`);
        }
      }
    });
}

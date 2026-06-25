import { Command } from 'commander';
import { readFileSync } from 'fs';
import { scrub } from '../../core/scrub.js';

export function handleScrub(text: string, options: { sessionId?: string; disable?: string }) {
  const disabledDetectors = options.disable ? options.disable.split(',').map((s) => s.trim()) : [];

  const result = scrub({
    content: text,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    options: {
      disabledDetectors,
    },
  });

  return result;
}

export function setupScrubCommand(program: Command) {
  program
    .command('scrub')
    .description('Scrub a file or stdin')
    .argument('[file]', 'File to scrub. If omitted, reads from stdin.')
    .option('--session-id <id>', 'Resume or target a specific session')
    .option('--disable <detectors>', 'Comma-separated list of detector names to skip')
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
        process.exit(0);
      }

      const result = handleScrub(input, options);

      // Print scrubbed content to stdout
      process.stdout.write(result.scrubbedContent as string);

      // Print session ID to stderr
      if (result.scrubbedContent !== input) {
        console.error(`Session ID: ${result.sessionId}`);
      }
    });
}

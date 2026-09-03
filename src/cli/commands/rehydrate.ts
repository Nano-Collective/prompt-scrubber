import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { resolveEncryptionKeyOrExit } from '../../core/cli-key-resolver.js';
import { SessionDecryptionError } from '../../core/crypto.js';
import { isSessionEncrypted } from '../../session/storage.js';
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
    .action(async (file, options) => {
      let input = '';

      if (file) {
        try {
          input = readFileSync(file, 'utf8');
        } catch (err: unknown) {
          console.error(`Error reading file: ${(err as Error).message}`);
          process.exit(1);
          return;
        }
      } else {
        // Read from stdin
        try {
          input = readFileSync(0, 'utf-8');
        } catch {
          console.error('No input provided.');
          process.exit(1);
          return;
        }
      }

      if (!input) {
        process.exit(0);
        return;
      }

      if (isSessionEncrypted(options.sessionId)) {
        await resolveEncryptionKeyOrExit();
      }

      try {
        const result = handleRehydrate(input, options);

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
      } catch (err: unknown) {
        if (err instanceof SessionDecryptionError) {
          console.error(err.message);
          process.exit(1);
          return;
        }
        throw err;
      }
    });
}

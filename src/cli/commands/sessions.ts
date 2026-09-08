import type { Command } from 'commander';
import { resolveEncryptionKeyOrExit } from '../../core/cli-key-resolver.js';
import { loadConfig } from '../../core/config.js';
import { SessionDecryptionError } from '../../core/crypto.js';
import {
  deleteSessionMap,
  gcSessions,
  isSessionEncrypted,
  listSessions,
  readSessionMap,
  sessionExists,
  writeSessionMap,
} from '../../session/storage.js';
import type { SessionMap } from '../../types/index.js';

export function setupSessionsCommands(program: Command) {
  const sessionsCommand = program.command('sessions').description('Manage scrub sessions');

  sessionsCommand
    .command('list')
    .description('List all saved sessions')
    .action(async () => {
      try {
        gcSessions(loadConfig().sessionTtlDays ?? 7);
      } catch (e) {
        console.error(`Warning: Failed to run session garbage collection: ${(e as Error).message}`);
      }

      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log('No saved sessions.');
        return;
      }

      // Only prompt for a key when at least one session on disk is encrypted.
      // Plaintext-only listings should never demand the passphrase just because
      // the global config flag is on.
      const hasEncrypted = sessions.some((s) => isSessionEncrypted(s.id));
      if (hasEncrypted) {
        await resolveEncryptionKeyOrExit();
      }

      console.log(`${'ID'.padEnd(40)} | ${'Last Modified'.padEnd(25)} | Placeholders`);
      console.log('-'.repeat(85));

      for (const session of sessions) {
        let map: SessionMap;
        try {
          map = readSessionMap(session.id);
        } catch (err: unknown) {
          if (err instanceof SessionDecryptionError) {
            console.error(`Session ${session.id}: ${err.message}`);
            continue;
          }
          throw err;
        }
        const count = Object.keys(map).length;
        const dateStr = session.lastModifiedAt.toLocaleString();

        console.log(`${session.id.padEnd(40)} | ${dateStr.padEnd(25)} | ${count}`);
      }
    });

  sessionsCommand
    .command('show')
    .description('Show the placeholder map for a session')
    .argument('<id>', 'Session ID to show')
    .action(async (id) => {
      // Only prompt for a key when the target session is actually encrypted.
      if (isSessionEncrypted(id)) {
        await resolveEncryptionKeyOrExit();
      }

      let map: SessionMap;
      try {
        map = readSessionMap(id);
      } catch (err: unknown) {
        if (err instanceof SessionDecryptionError) {
          console.error(err.message);
          process.exit(1);
          return;
        }
        throw err;
      }
      if (Object.keys(map).length === 0) {
        console.error(`Session ${id} not found.`);
        process.exit(1);
      }
      console.log(JSON.stringify(map, null, 2));
    });

  sessionsCommand
    .command('rm')
    .description('Delete a session')
    .argument('[id]', 'Session ID to delete')
    .option('--all', 'Delete all sessions')
    .action((id, options) => {
      if (options.all) {
        const sessions = listSessions();
        if (sessions.length === 0) {
          console.log('No sessions to remove.');
          return;
        }
        for (const session of sessions) {
          deleteSessionMap(session.id);
        }
        console.log(`Deleted ${sessions.length} sessions.`);
        return;
      }

      if (!id) {
        console.error("error: missing required argument 'id'");
        process.exit(1);
      }

      const success = deleteSessionMap(id);
      if (success) {
        console.log(`Session ${id} deleted.`);
      } else {
        console.error(`Session ${id} not found.`);
        process.exit(1);
      }
    });

  sessionsCommand
    .command('gc')
    .description('Garbage collect expired sessions')
    .action(() => {
      try {
        const deletedCount = gcSessions(loadConfig().sessionTtlDays ?? 7);
        console.log(`Deleted ${deletedCount} expired session(s).`);
      } catch (e) {
        console.error(`Error: Failed to run session garbage collection: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  sessionsCommand
    .command('encrypt')
    .description(
      'Re-encrypt existing plaintext sessions on disk (requires encryptionEnabled + PROMPT_SCRUB_KEY). Pass --rekey to also rewrite already-encrypted sessions with a fresh passphrase.',
    )
    .argument('[id]', 'Session ID to encrypt; encrypts all sessions if omitted')
    .option('--rekey', 'Rewrite already-encrypted sessions too (use to rotate the passphrase)')
    .action(async (id, options) => {
      const config = loadConfig();
      if (!config.encryptionEnabled) {
        console.error(
          'encryption is not enabled in the config file. Set "encryptionEnabled": true in ~/.config/prompt-scrub/config.json first.',
        );
        process.exit(1);
        return;
      }

      await resolveEncryptionKeyOrExit();

      const targets = id ? [id] : listSessions().map((s) => s.id);

      if (targets.length === 0) {
        console.log('No sessions to encrypt.');
        return;
      }

      let encrypted = 0;
      let skipped = 0;
      let missing = 0;
      for (const sessionId of targets) {
        // Guard against fabricating an empty session: a missing file must
        // never produce a new file on the encrypt path.
        if (!sessionExists(sessionId)) {
          missing += 1;
          if (id) {
            console.error(`Session ${sessionId} not found.`);
            process.exit(1);
            return;
          }
          continue;
        }

        const alreadyEncrypted = isSessionEncrypted(sessionId);
        if (alreadyEncrypted && !options.rekey) {
          skipped += 1;
          continue;
        }
        try {
          const map = readSessionMap(sessionId);
          writeSessionMap(sessionId, map);
          encrypted += 1;
        } catch (err: unknown) {
          if (err instanceof SessionDecryptionError) {
            console.error(`Session ${sessionId}: ${err.message}`);
            process.exit(1);
            return;
          }
          throw err;
        }
      }

      const tail =
        skipped > 0 ? `, ${skipped} already encrypted (use --rekey to rotate the passphrase)` : '';
      const missingTail = missing > 0 && !id ? `, ${missing} missing skipped` : '';
      console.log(`Encrypted ${encrypted} session(s)${tail}${missingTail}.`);
    });
}

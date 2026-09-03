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

      // Pull the key up-front if anything on disk looks encrypted, so a wrong
      // key fails fast before we waste time parsing every session.
      const hasEncrypted = sessions.some((s) => isSessionEncrypted(s.id));
      const config = loadConfig();
      if (config.encryptionEnabled || hasEncrypted) {
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
        const dateStr = session.createdAt.toLocaleString();

        console.log(`${session.id.padEnd(40)} | ${dateStr.padEnd(25)} | ${count}`);
      }
    });

  sessionsCommand
    .command('show')
    .description('Show the placeholder map for a session')
    .argument('<id>', 'Session ID to show')
    .action(async (id) => {
      const config = loadConfig();
      if (config.encryptionEnabled || isSessionEncrypted(id)) {
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
      'Re-encrypt existing plaintext sessions on disk (requires encryptionEnabled + PROMPT_SCRUB_KEY)',
    )
    .argument('[id]', 'Session ID to encrypt; encrypts all sessions if omitted')
    .action(async (id) => {
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
      for (const sessionId of targets) {
        if (isSessionEncrypted(sessionId)) {
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

      console.log(
        `Encrypted ${encrypted} session(s)${skipped > 0 ? `, ${skipped} already encrypted` : ''}.`,
      );
    });
}

import type { Command } from 'commander';
import { deleteSessionMap, listSessions, readSessionMap } from '../../session/storage.js';

export function setupSessionsCommands(program: Command) {
  const sessionsCommand = program.command('sessions').description('Manage scrub sessions');

  sessionsCommand
    .command('list')
    .description('List all saved sessions')
    .action(() => {
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log('No saved sessions.');
        return;
      }

      console.log(`${'ID'.padEnd(40)} | ${'Created'.padEnd(25)} | Placeholders`);
      console.log('-'.repeat(85));

      for (const session of sessions) {
        // Read the map to count placeholders
        const map = readSessionMap(session.id);
        const count = Object.keys(map).length;
        const dateStr = session.createdAt.toLocaleString();

        console.log(`${session.id.padEnd(40)} | ${dateStr.padEnd(25)} | ${count}`);
      }
    });

  sessionsCommand
    .command('show')
    .description('Show the placeholder map for a session')
    .argument('<id>', 'Session ID to show')
    .action((id) => {
      // listSessions to check existence (or just read and see if it's empty)
      const map = readSessionMap(id);
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
}

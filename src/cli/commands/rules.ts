import { Command } from 'commander';
import { getAvailableDetectors } from '../../core/detectors.js';

export function setupRulesCommands(program: Command) {
  const rulesCmd = program
    .command('rules')
    .description('Manage and inspect active detectors and rules');

  rulesCmd
    .command('list')
    .description('List the active detector set, including rule pack detectors')
    .action(() => {
      const detectors = getAvailableDetectors();

      if (detectors.length === 0) {
        console.log('No detectors found.');
        return;
      }

      // Compute column widths for padding
      const maxNameLen = Math.max(...detectors.map((d) => d.name.length), 'Detector'.length);
      const maxSourceLen = Math.max(...detectors.map((d) => d.source.length), 'Source'.length);
      const defaultStateLen = 'Default State'.length;

      // Print header
      console.log(
        'Detector'.padEnd(maxNameLen) +
          '   ' +
          'Source'.padEnd(maxSourceLen) +
          '   ' +
          'Default State',
      );

      console.log(
        ''.padEnd(maxNameLen, '-') +
          '   ' +
          ''.padEnd(maxSourceLen, '-') +
          '   ' +
          ''.padEnd(defaultStateLen, '-'),
      );

      // Print rows
      for (const d of detectors) {
        console.log(
          d.name.padEnd(maxNameLen) +
            '   ' +
            d.source.padEnd(maxSourceLen) +
            '   ' +
            d.defaultState,
        );
      }
    });
}

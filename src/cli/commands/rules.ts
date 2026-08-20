import type { Command } from 'commander';
import { type DetectorMetadata, getAvailableDetectorsAsync } from '../../core/detectors.js';

function localesOf(detector: DetectorMetadata): string {
  return detector.locales && detector.locales.length > 0 ? detector.locales.join(', ') : '-';
}

export function setupRulesCommands(program: Command) {
  const rulesCmd = program
    .command('rules')
    .description('Manage and inspect active detectors and rules');

  rulesCmd
    .command('list')
    .description('List the active detector set, including rule pack detectors')
    .action(async () => {
      const detectors = await getAvailableDetectorsAsync();

      if (detectors.length === 0) {
        console.log('No detectors found.');
        return;
      }

      // Compute column widths for padding
      const maxNameLen = Math.max(...detectors.map((d) => d.name.length), 'Detector'.length);
      const maxSourceLen = Math.max(...detectors.map((d) => d.source.length), 'Source'.length);
      const defaultStateLen = 'Default State'.length;
      const showLocales = detectors.some((d) => d.locales && d.locales.length > 0);

      // Print header
      console.log(
        'Detector'.padEnd(maxNameLen) +
          '   ' +
          'Source'.padEnd(maxSourceLen) +
          '   ' +
          (showLocales ? 'Default State   Locales' : 'Default State'),
      );

      console.log(
        ''.padEnd(maxNameLen, '-') +
          '   ' +
          ''.padEnd(maxSourceLen, '-') +
          '   ' +
          ''.padEnd(defaultStateLen, '-') +
          (showLocales ? `   ${''.padEnd('Locales'.length, '-')}` : ''),
      );

      // Print rows
      for (const d of detectors) {
        console.log(
          d.name.padEnd(maxNameLen) +
            '   ' +
            d.source.padEnd(maxSourceLen) +
            '   ' +
            (showLocales
              ? `${d.defaultState.padEnd(defaultStateLen)}   ${localesOf(d)}`
              : d.defaultState),
        );
      }
    });
}

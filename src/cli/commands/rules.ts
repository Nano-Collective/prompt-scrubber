import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { type DetectorMetadata, getAvailableDetectorsAsync } from '../../core/detectors.js';
import { resolveLocale } from '../locale.js';

function localesOf(detector: DetectorMetadata): string {
  return detector.locales && detector.locales.length > 0 ? detector.locales.join(', ') : '-';
}

/**
 * Whether the resolved locale lets a locale-scoped detector run. Kept separate
 * from `Default State`, which stays the detector's own default so the two
 * meanings never share a column.
 */
function localeStateOf(detector: DetectorMetadata): string {
  if (detector.localeActive === undefined) return '-';
  return detector.localeActive ? 'active' : 'inactive';
}

/** Renders rows as a fixed-width table, padding every column to its widest cell. */
function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('   ')
      .trimEnd();

  return [line(headers), line(widths.map((width) => ''.padEnd(width, '-'))), ...rows.map(line)];
}

export function setupRulesCommands(program: Command) {
  const rulesCmd = program
    .command('rules')
    .description('Manage and inspect active detectors and rules');

  rulesCmd
    .command('list')
    .description('List the active detector set, including rule pack detectors')
    .option(
      '--locale <locale>',
      'Resolve locale-scoped detectors against this BCP-47 tag instead of the configured locale',
    )
    .action(async (options: { locale?: string }) => {
      let locale: string;
      try {
        locale = resolveLocale(options.locale, loadConfig().locale);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
        return;
      }

      const detectors = await getAvailableDetectorsAsync(locale);

      if (detectors.length === 0) {
        console.log('No detectors found.');
        return;
      }

      const showLocales = detectors.some((d) => d.locales && d.locales.length > 0);

      if (showLocales) {
        console.error(`Active locale: ${locale || '(none)'}`);
      }

      const headers = ['Detector', 'Source', 'Default State'];
      if (showLocales) {
        headers.push('Locales', 'Locale State');
      }

      const rows = detectors.map((d) => {
        const row = [d.name, d.source, d.defaultState];
        if (showLocales) {
          row.push(localesOf(d), localeStateOf(d));
        }
        return row;
      });

      for (const line of renderTable(headers, rows)) {
        console.log(line);
      }
    });
}

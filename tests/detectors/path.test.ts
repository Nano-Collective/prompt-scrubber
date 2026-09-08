import test from 'ava';
import { PathDetector } from '../../src/detectors/path.js';

const detector = new PathDetector();

// --- Positive Cases ---

test('detects a Linux absolute path', (t) => {
  const findings = detector.detect('Config at /home/akram/.config/app/settings.json');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '/home/akram/.config/app/settings.json');
  t.is(findings[0]?.placeholderPrefix, 'Path');
});

test('detects /var/log path', (t) => {
  const findings = detector.detect('Check /var/log/syslog for errors.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '/var/log/syslog');
});

test('detects home directory shorthand', (t) => {
  const findings = detector.detect('Project is in ~/code/my-project');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '~/code/my-project');
});

test('detects ~/.config path', (t) => {
  const findings = detector.detect('Settings stored in ~/.config/prompt-scrub/');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '~/.config/prompt-scrub/');
});

test('detects Windows absolute path', (t) => {
  const findings = detector.detect('File at C:\\Users\\John\\Documents\\report.docx');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Users\\John\\Documents\\report.docx');
});

// --- Windows paths and spaces (#123) ---

test('Windows path ends before following prose rather than running to end of line', (t) => {
  const text = 'Config at C:\\app\\cfg.ini owner alice@corp.com';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\app\\cfg.ini');
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'C:\\app\\cfg.ini');
});

test('Windows path ends before a following secret', (t) => {
  const findings = detector.detect(
    'Deploy from C:\\srv\\app with token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\srv\\app');
});

test('a later backslash does not re-open the match across intervening prose', (t) => {
  // The greedy interior segment used to bridge "b.txt … share\" and swallow the
  // email between them.
  const findings = detector.detect('Log C:\\a\\b.txt mail alice@corp.com dir share\\x.txt');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\a\\b.txt');
});

test('detects an unquoted path whose trailing segment contains a space', (t) => {
  const text = 'Path is C:\\Program Files';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Program Files');
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'C:\\Program Files');
});

test('detects an unquoted user directory whose trailing segment contains a space', (t) => {
  const findings = detector.detect('User dir C:\\Users\\John Doe');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Users\\John Doe');
});

test('a trailing segment with an extension does not absorb a capitalised sentence', (t) => {
  const findings = detector.detect('Read C:\\logs\\out.txt Failed to start');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\logs\\out.txt');
});

test('detects a path with spaces in several segments', (t) => {
  const findings = detector.detect('In C:\\Program Files (x86)\\Common Files\\app.dll here');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Program Files (x86)\\Common Files\\app.dll');
});

// A space-bearing segment that starts lowercase is still part of the path. These
// truncated before, leaving the tail — a surname, employer or filename — in
// cleartext next to a placeholder, which is the #123 signature.

test('a lowercase space-bearing segment does not truncate the path', (t) => {
  const findings = detector.detect('Home C:\\Users\\john smith\\AppData\\creds.json');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Users\\john smith\\AppData\\creds.json');
});

test('continues over a space when the next token contains a backslash', (t) => {
  const findings = detector.detect('Build failed in C:\\repos\\my project\\src\\config.ini');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\repos\\my project\\src\\config.ini');
});

test('continues over a space when the next token carries a file extension', (t) => {
  const findings = detector.detect('C:\\dev\\acme corp\\client list.csv');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\dev\\acme corp\\client list.csv');
});

test('a lowercase filename with a space is matched in full', (t) => {
  const findings = detector.detect('Report C:\\data\\quarterly report.xlsx done');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\data\\quarterly report.xlsx');
});

test('a digit-led space-bearing segment does not truncate the path', (t) => {
  const findings = detector.detect('Backup to D:\\backups\\jan 2026\\payroll.xlsx');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'D:\\backups\\jan 2026\\payroll.xlsx');
});

test('a following token that reads as a filename is over-matched, not dropped', (t) => {
  // "alice@corp.com" ends in ".com", so the detector keeps going rather than
  // truncating. Over-matching is the safe direction — resolveCollisions narrows
  // the Path against the Email, and the end-to-end result is asserted in
  // tests/core/scrub.test.ts. Truncating here would leak the surname.
  const findings = detector.detect('C:\\Users\\John Doe alice@corp.com');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Users\\John Doe alice@corp.com');
});

test('detects a quoted Windows path whose final segment contains a space', (t) => {
  const findings = detector.detect('Run "C:\\Users\\John Doe\\My Docs\\a b.txt" ok');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\Users\\John Doe\\My Docs\\a b.txt');
});

test('returns a correct span for a quoted Windows path', (t) => {
  const text = 'Open "C:\\Program Files\\App\\app.exe" now';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'C:\\Program Files\\App\\app.exe');
});

test('detects two Windows paths on the same line', (t) => {
  const findings = detector.detect('Copy C:\\a\\b.txt to D:\\c\\d.txt');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'C:\\a\\b.txt');
  t.is(findings[1]?.value, 'D:\\c\\d.txt');
});

test('a newline ends a Windows path match', (t) => {
  const findings = detector.detect('Path C:\\a\\b\nalice@corp.com');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\a\\b');
});

test('a tab ends a Windows path match', (t) => {
  const findings = detector.detect('Path C:\\a\\b\tNext');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\a\\b');
});

// A space before a second drive spec never continues the first path (#127
// follow-up): without a guard, the capitalised or backslash-bearing drive
// letter reads as ordinary path continuation and swallows it, destroying the
// second path's own "X:\" prefix so it can never be re-matched — the tail is
// then left in cleartext next to a placeholder.

test('a copy-style command keeps source and destination as two paths', (t) => {
  const findings = detector.detect('copy C:\\src\\bin D:\\dest\\bin');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'C:\\src\\bin');
  t.is(findings[1]?.value, 'D:\\dest\\bin');
});

test('an xcopy-style command keeps source and destination as two paths', (t) => {
  const findings = detector.detect('xcopy C:\\Users\\bob\\docs C:\\backup\\docs');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'C:\\Users\\bob\\docs');
  t.is(findings[1]?.value, 'C:\\backup\\docs');
});

test('a comma-separated list of paths does not merge into one finding', (t) => {
  const findings = detector.detect('Files: C:\\a\\b, D:\\c\\d');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'C:\\a\\b');
  t.is(findings[1]?.value, 'D:\\c\\d');
});

test('a semicolon-separated PATH list splits into separate paths', (t) => {
  const findings = detector.detect('SET PATH=C:\\tools;C:\\bin');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'C:\\tools');
  t.is(findings[1]?.value, 'C:\\bin');
});

// An all-caps token after an extension-less path reads as a log-level or
// status word, not a path component — the swallowed prose is context the
// model needs (build logs and stack traces are exactly what this targets).

test('an all-caps status word after the path is not absorbed', (t) => {
  const findings = detector.detect('Build output C:\\src\\build FAILED after 3 retries');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\src\\build');
});

// A sentence-initial capital (mixed case, unlike an all-caps word above) is
// still indistinguishable from a genuine path component such as "John Doe" or
// "Program Files", so it is over-matched rather than dropped — the safe
// direction per the detector's design note. Pinned here so a future change to
// this boundary is deliberate.

test('a sentence-initial capital after an extension-less path is over-matched, not dropped', (t) => {
  const findings = detector.detect('Failed to open C:\\app\\cfg Error 404 occurred');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\app\\cfg Error 404');
});

// A quoted path takes everything between its quotes, including trailing prose
// — the quotes are the user's own delimiter, so this is accepted over-match
// rather than a boundary the detector tries to guess. Pinned so a change here
// is deliberate rather than accidental.

test('a quoted path absorbs trailing prose inside the same quotes', (t) => {
  const findings = detector.detect('Error: "C:\\app\\config.json not found" at startup');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'C:\\app\\config.json not found');
});

test('detects multiple paths in one string', (t) => {
  const findings = detector.detect('Copy /etc/hosts to ~/Desktop/hosts.bak');
  t.is(findings.length, 2);
});

test('returns correct span for a path', (t) => {
  const text = 'See /home/user/file.txt for details';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), '/home/user/file.txt');
});

// --- Negative Cases ---

test('does not match a bare slash', (t) => {
  const findings = detector.detect('Use / as the separator');
  t.is(findings.length, 0);
});

test('does not match a single-segment path like /tmp', (t) => {
  // "/tmp" alone has only 1 segment — should not match
  const findings = detector.detect('Temp dir is /tmp but nothing else');
  t.is(findings.length, 0);
});

test('does not match plain text', (t) => {
  const findings = detector.detect('This is just a normal sentence.');
  t.is(findings.length, 0);
});

test('does not match a URL as a path', (t) => {
  const findings = detector.detect('Visit https://example.com/docs');
  // URL detector handles this; PathDetector should not fire
  t.is(findings.length, 0);
});

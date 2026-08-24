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

// --- Confidence ---

test('scores unambiguous filesystem markers above a bare absolute path', (t) => {
  const unix = detector.detect('Open /var/log/system.log now');
  t.is(unix[0]?.confidence, 0.8);
  t.is(unix[0]?.method, 'structural');

  const home = detector.detect('Open ~/.config/app.json now');
  t.is(home[0]?.confidence, 0.9);

  const win = detector.detect('Open C:\\Users\\alice now');
  t.is(win[0]?.confidence, 0.9);
});

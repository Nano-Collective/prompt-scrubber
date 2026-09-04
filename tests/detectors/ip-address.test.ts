import test from 'ava';
import { IpAddressDetector } from '../../src/detectors/ip-address.js';

const detector = new IpAddressDetector();

// --- IPv4 Positive Cases ---

test('detects standard private IPv4 address (Class C)', (t) => {
  const findings = detector.detect('Database server is at 192.168.1.50 in subnet.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '192.168.1.50');
  t.is(findings[0]?.category, 'IpAddress');
  t.is(findings[0]?.placeholderPrefix, 'IpAddress');
});

test('detects standard private IPv4 address (Class A & B)', (t) => {
  const findings = detector.detect('Internal hosts: 10.0.0.1 and 172.16.254.1.');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '10.0.0.1');
  t.is(findings[1]?.value, '172.16.254.1');
});

test('detects public IPv4 and loopback addresses', (t) => {
  const findings = detector.detect('DNS: 8.8.8.8, Local: 127.0.0.1, Broadcast: 255.255.255.255');
  t.is(findings.length, 3);
  t.is(findings[0]?.value, '8.8.8.8');
  t.is(findings[1]?.value, '127.0.0.1');
  t.is(findings[2]?.value, '255.255.255.255');
});

test('detects IPv4 at the start and end of string', (t) => {
  const findings = detector.detect('192.168.0.1 is gateway, remote is 10.10.10.10');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '192.168.0.1');
  t.is(findings[1]?.value, '10.10.10.10');
});

// --- IPv6 Positive Cases ---

test('detects full 8-group IPv6 address', (t) => {
  const findings = detector.detect('Connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 now');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '2001:0db8:85a3:0000:0000:8a2e:0370:7334');
  t.is(findings[0]?.category, 'IpAddress');
});

test('detects compressed IPv6 loopback and link-local addresses', (t) => {
  const findings = detector.detect('Loopback ::1 and link-local fe80::1ff:fe23:4567:890a');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '::1');
  t.is(findings[1]?.value, 'fe80::1ff:fe23:4567:890a');
});

test('detects compressed IPv6 with double colons in middle', (t) => {
  const findings = detector.detect('Server address: 2001:db8::8a2e:370:7334');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '2001:db8::8a2e:370:7334');
});

// --- Span & Offset Accuracy ---

test('span accurately indexes text slice for IPv4 and IPv6', (t) => {
  const text = 'Primary: 192.168.1.1, Secondary: 2001:db8::1, End.';
  const findings = detector.detect(text);
  t.is(findings.length, 2);

  for (const finding of findings) {
    const [start, end] = finding.span;
    t.is(text.slice(start, end), finding.value);
  }
});

// --- Negative Cases & False Positive Prevention ---

test('does not match out-of-bounds IPv4 octets (>255)', (t) => {
  const findings = detector.detect('Invalid IPs: 256.0.0.1, 999.999.999.999, 192.168.1.300');
  t.is(findings.length, 0);
});

// A 4-component version like 1.2.3.4 is also a syntactically valid IPv4 address, so
// it is deliberately still matched. Only the shapes below are distinguishable by regex:
// 5+ segments, and a version prefixed with a letter.
test('does not match 5-segment versions or letter-prefixed versions', (t) => {
  const findings = detector.detect('Release version 1.2.3.4.5 and v2.0.0.1');
  t.is(findings.length, 0);
});

test('absorbs a CIDR suffix instead of leaving a dangling mask', (t) => {
  const findings = detector.detect('Subnet 192.168.1.0/24 routed');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '192.168.1.0/24');
});

test('does not match a bare double colon in prose', (t) => {
  t.is(detector.detect('Compare a :: b in the spec').length, 0);
  t.is(detector.detect('Use std::vector for this').length, 0);
});

test('does not match plain numbers or dates', (t) => {
  const findings = detector.detect('Date: 2026.08.30, total: 3.14159');
  t.is(findings.length, 0);
});

test('does not match MAC addresses as IPv6', (t) => {
  const findings = detector.detect('Device MAC: 00:1A:2B:3C:4D:5E on eth0');
  t.is(findings.length, 0);
});

test('returns empty array for clean text', (t) => {
  const findings = detector.detect('No IP addresses in this sentence at all.');
  t.is(findings.length, 0);
});

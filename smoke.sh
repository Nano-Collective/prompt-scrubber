#!/bin/bash
set -e

# SMK-004
echo "Call +44 7911 123456" | prompt-scrub inspect
prompt-scrub sessions list

# SMK-005
echo "Email me at hello@example.com" | prompt-scrub scrub

# SMK-006
echo "Contact alice@example.com or visit https://example.com/api at /usr/var/log. Key: sk-123456" > test.txt
prompt-scrub scrub test.txt

# SMK-007
echo "Email: user@example.com Secret: user@example.com" | prompt-scrub scrub

# SMK-008
echo "Contact alice@example.com and reply to alice@example.com" | prompt-scrub scrub

# SMK-009
echo "My email is test@test.com" | prompt-scrub scrub --disable EmailDetector

# SMK-010
echo "Hello world, this is a clean prompt." | prompt-scrub scrub

# SMK-011
echo "Key is sk-abc" | prompt-scrub scrub > scrubbed.txt 2> session.err
UUID=$(cat session.err | grep -o "Session ID: .*" | awk '{print $3}')
cat scrubbed.txt | prompt-scrub rehydrate --session-id $UUID

# SMK-012
echo "Email_1 and Phone_99" | prompt-scrub rehydrate --session-id $UUID

# SMK-013
echo "Email_1" | prompt-scrub rehydrate --session-id fake-uuid-1234 || true


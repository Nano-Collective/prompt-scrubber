# nc-review rubric — prompt-scrub

This is the **project** half of the rubric: what prompt-scrub cares about. The
reviewing method — how to read a diff against a base checkout, how to rate
severity, what to emit — is the shared base rubric you were also given. Read
both; where they disagree, this file wins.

## What this project is, and why that changes review

prompt-scrub strips identifying content out of a prompt **before it leaves the
user's machine**, replaces each value with a stable placeholder, and rehydrates
the model's reply afterwards.

So the failure that matters here is not a crash. It is **a value that should
have been replaced and was not**, because that value has already reached a
third-party LLM by the time anyone notices. A missed detection is silent, and
it is unrecoverable.

Weigh findings accordingly:

- **A leak is `blocking`**, even if it needs an unusual input to trigger.
- **Over-scrubbing is `important`**, not `blocking` — it corrupts the user's
  prose and is annoying, but it does not disclose anything.
- A crash is usually `important`. It is loud, and loud failures in this product
  are safe failures.

The README is explicit that this is *partial defence, not anonymity*. Do not
file findings demanding guarantees the project does not claim. Do file them when
a change quietly weakens a defence it does claim.

## Where the bugs actually are

Every one of these has shipped or been fixed here. Check them before anything
else.

### Span arithmetic in detectors

A detector returns a span, and the scrubber splices on it. If the start index is
derived from the wrong thing — the match group rather than `match[0]`, or a
length that does not account for a leading separator — the splice lands off by a
few characters. That either leaves part of the original in place (a leak) or
eats a neighbouring character (corruption). See the phone detector's history.

When a diff touches span or index computation, work the arithmetic yourself
against a concrete example before accepting it.

### Overlapping matches between detectors

Two detectors can match overlapping regions of the same line — a path
immediately followed by an email, a secret inside a URL. If the resolution order
or the offset bookkeeping is wrong, one replacement shifts the other's span and
something survives unredacted. This has produced a real leak on Windows paths.

Ask: what happens when this detector's match is adjacent to, or contained by,
another's on the same line?

### Over-matching prose

The name, postal-address and code-tell detectors work on natural language and
will happily eat ordinary sentences. A change that widens one of these needs to
show it does not swallow prose.

### Placeholder identity and collisions

Placeholders must be **stable within a session** — the same value always maps to
the same placeholder, and two different values never share one. Rehydration
depends entirely on that. A change touching the collision resolver, the session
map, or anything that decides when a new session begins should be read against
both properties. Watch mode in particular has had a bug where a fresh session
per message let placeholders collide.

### Rehydration is exact or it is wrong

Rehydrate must restore the original text, not an approximation. A partial or
fuzzy restore hands the user output that looks right and is not.

## Local-first is a hard constraint

Nothing in the scrub path may make a network call, and no dependency added to
that path may either. A new runtime dependency in `src/` deserves a look at what
it does on import. This is a tool people run *because* they do not trust the
network; a phone-home in it would be the worst possible defect.

Session files hold the mapping between placeholders and the **original**
sensitive values. Treat anything that changes where they are written, what is in
them, or their permissions as security-relevant.

## Public contracts

Breaking these is `blocking` without a matching changeset and a deliberate
version bump:

- **The placeholder format.** Sessions written by an older version are
  rehydrated by a newer one; change the format and you break that.
- **The session file shape** — `SessionMap` and what `src/session/storage.ts`
  persists.
- **`Detector`, `Finding`, `ScrubResult`, `RehydrateResult`** and the rest of
  `src/types/` — these are exported and third-party rule packs depend on them.
- **CLI flags and the config schema** across `scrub`, `rehydrate`, `inspect`,
  `sessions`, `watch`, `rules`, `config`.

## Tests

Tests live in **`tests/**/*.test.ts`** — a separate tree, not colocated, and not
`.spec.ts`. Ava is configured to look only there, so a test file put next to the
source will silently never run. That is worth flagging when you see it.

A new or modified detector needs cases for:

- the value it is meant to catch, in isolation
- the same value adjacent to another detector's match on one line
- something similar that it must **not** match

A detector change with only a positive case is under-tested; say so, because the
negative case is where over-matching hides.

## Scope

Detectors are the easiest place to contribute and the easiest place to do harm,
so expect many small detector PRs. Judge them on whether the pattern is right
and the tests prove it, not on size.

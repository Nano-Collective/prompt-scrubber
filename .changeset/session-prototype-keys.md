---
"@nanocollective/prompt-scrub": patch
---

Fixed values and categories named like `Object.prototype` members. A detected value such as `constructor`, `toString` or `__proto__` read back an inherited function from the session lookup, so the text was replaced with `function Object() { [native code] }`, nothing was saved to the session map, and the original could not be restored. A category with such a name had its counter and statistics corrupted the same way. Lookups now use `Map`s and the statistics counters ignore inherited names. Closes #170.

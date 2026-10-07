---
"@nanocollective/prompt-scrub": patch
---

Fixed the **postal-address detector** redacting ordinary prose. Any number followed later in the sentence by a street suffix counted as an address, so `There are 42 things you should consider when walking down the st.` was flagged. The street name between the house number and the suffix is now limited to a few short words and can no longer run over a second number. `10 Downing St` and `1600 Pennsylvania Ave.` still match. Thanks to @RealBhupesh. Closes #86.

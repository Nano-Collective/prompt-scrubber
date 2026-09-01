---
title: "Authoring Rule Packs"
description: "How to build and distribute custom detectors for prompt-scrubber"
sidebar_order: 3
---

# Authoring Rule Packs

Rule packs are the primary extensibility mechanism in `prompt-scrubber`. A rule pack is simply an npm package that exports an array of custom detectors. Users can install your package and configure `prompt-scrubber` to load your detectors dynamically on startup.

## The Rule-Pack Contract

To be a valid rule pack, your npm package must expose detectors that conform to the `Detector` interface. 

The CLI expects your package to export its detectors in one of three ways:
1. As a `default` export containing an array of detectors.
2. As a named export called `detectors` containing an array of detectors.
3. As a `default` export object that has a `detectors` property containing the array.

### Detector Interface

Your detectors must conform to the following interface:

```typescript
export interface Finding {
  category: string;
  span: [number, number]; // [startIndex, endIndex]
  value: string;
  placeholderPrefix: string;
}

export interface Detector {
  name: string; // A unique name for your detector
  detect(text: string): Finding[];
}
```

`placeholderPrefix` may be any string that does not contain `«` or `»` — digits and underscores are fine, so `Ticket2` and `Jira_Issue` both work. The engine mints `«<prefix>_<n>»`, recognises that shape when reserving tokens already present in the text, and matches it again on rehydration, so a prefix outside that rule would produce a placeholder that never round-trips.

> **Note to Whitepaper Readers:** 
> The original whitepaper conceptually defines a `Finding` as `{ category, span, replacement }`. The canonical runtime interface explicitly omits `replacement` because the exact placeholder (e.g. `Email_2`) requires session state, which detectors do not have. Rule-pack authors must return `value` and `placeholderPrefix`, allowing the core engine to deterministically generate the final replacement.

## Example: Building a Minimal Rule Pack

Let's build a rule pack that detects "Project X" codenames.

1. **Initialize the package**:
   ```bash
   mkdir prompt-scrub-projectx && cd prompt-scrub-projectx
   npm init -y
   ```

2. **Write your detector**:
   Create a file `index.js` (or compile from TypeScript):

   ```javascript
   class ProjectXDetector {
     constructor() {
       this.name = 'ProjectXDetector';
       // We'll search for 'Apollo' and 'Zeus'
       this.regex = /\b(Apollo|Zeus)\b/gi;
     }

     detect(text) {
       const findings = [];
       let match;
       this.regex.lastIndex = 0;

       while ((match = this.regex.exec(text)) !== null) {
         findings.push({
           category: 'ProjectX',
           span: [match.index, match.index + match[0].length],
           value: match[0],
           placeholderPrefix: 'Codename',
         });
       }

       return findings;
     }
   }

   // Export using the named 'detectors' array format
   module.exports = {
     detectors: [new ProjectXDetector()]
   };
   ```

3. **Publish (or test locally)**:
   You can publish this package to npm, or users can install it locally:
   ```bash
   npm install /path/to/prompt-scrub-projectx
   ```

4. **Configuration**:
   Users can then add it to their configuration file (`prompt-scrub init` creates one):
   ```json
   {
     "rulePacks": ["prompt-scrub-projectx"],
     "urlAllowlist": []
   }
   ```

5. **Verify**:
   Once configured, users will see it when they run `prompt-scrub rules list`:
   ```bash
   $ npx prompt-scrub rules list
   Detector           Source                               Default State
   ----------------   ----------------------------------   -------------
   SecretDetector     built-in                             on
   ...
   ProjectXDetector   rule-pack: prompt-scrub-projectx     on
   ```

## Priority and Collision Resolution

Your custom detectors participate in the same collision resolution process as built-in detectors. If your custom detector flags text that overlaps with another finding, the `prompt-scrubber` engine will resolve the conflict:

- **Overlap**: The longer span wins.
- **Priority**: Custom detectors resolve alongside the default fallback priority. Currently, there is no mechanism to enforce a custom detector overriding `SecretDetector`. If a secret overlaps with your custom finding, the `SecretDetector` will always win to prevent accidental secret leakage.

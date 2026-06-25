# Examples

Here are some real-world examples of `prompt-scrub` in action.

## Example 1: Basic Identifiers

**Input**
```text
My email is akram@example.com
API key: sk-123456
```

**Scrubbed**
```text
My email is Email_1
API key: Secret_1
```

**Rehydrated**
```text
My email is akram@example.com
API key: sk-123456
```

## Example 2: Paths and URLs

**Input**
```text
I'm getting an error when fetching https://internal.company.com/api from /Users/akram/dev/app/src/main.ts
```

**Scrubbed**
```text
I'm getting an error when fetching Url_1 from Path_1
```

**Rehydrated**
```text
I'm getting an error when fetching https://internal.company.com/api from /Users/akram/dev/app/src/main.ts
```

## Example 3: The Limits of the Scrubber (Rich Example)

**Input**
```text
Hey, I'm Will. My team is hitting a deploy failure on https://staging.acme-internal.io.
The error from the GitHub Actions run is:
  Error: secret not found: ANTHROPIC_API_KEY=sk-ant-abc123...
  at /Users/will/work/acme/.github/workflows/deploy.yml:42
Can you take a look?
```

**Scrubbed (assuming Name detector is opted-in)**
```text
Hey, I'm Name_1. My team is hitting a deploy failure on Url_1.
The error from the GitHub Actions run is:
  Error: secret not found: Secret_1
  at Path_1
Can you take a look?
```

**Model Response**
```text
The error means the workflow is trying to read ANTHROPIC_API_KEY from the environment. Check the Path_1 line. Also, never hardcode Secret_2 in your files.
```

**Rehydrated**
```text
The error means the workflow is trying to read ANTHROPIC_API_KEY from the environment. Check the /Users/will/work/acme/.github/workflows/deploy.yml line. Also, never hardcode Secret_2 in your files.
```

*Note: A warning is emitted to `stderr` indicating `Secret_2` was not found in the session map (the model hallucinated a placeholder). The library passes it through unchanged.*

**What Slipped Through (The Gap):**
The developer's writing style ("Hey, I'm Will. My team is hitting..."), the fact that they have a team, and the cadence of their question. Style fingerprinting is not solved in v1.

## Example 4: Node.js Library Integration

**Code**
```typescript
import { scrub, rehydrate } from '@nanocollective/prompt-scrub';

const prompt = "My secret is sk-123456789";

// 1. Scrub the prompt
const { scrubbedContent, sessionId } = scrub({ content: prompt });
console.log(scrubbedContent); // "My secret is Secret_1"

// 2. Send to LLM...
const response = "You shouldn't share Secret_1.";

// 3. Rehydrate the response
const { content } = rehydrate({ content: response, sessionId });
console.log(content); // "You shouldn't share sk-123456789."
```

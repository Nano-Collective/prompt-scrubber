---
title: "Setup & Verification"
description: "Verify your installation"
sidebar_order: 3
---

# Setup & Verification

After installing `prompt-scrub`, you can verify that it is set up correctly by running a few quick commands.

## Check Version

Verify that the CLI is accessible and check the installed version:

```bash
prompt-scrub --version
```

## View Help

Explore the available commands and options:

```bash
prompt-scrub --help
```

## Run a Smoke Test

To ensure the scrubbing engine is functioning correctly, pipe a test string into the `scrub` command:

```bash
echo "My secret email is test@example.com" | prompt-scrub scrub
```

You should see an output similar to:
```
My secret email is Email_1
```

If these commands succeed, your installation is ready to use!

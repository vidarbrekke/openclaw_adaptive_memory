---
name: adaptive-memory
description: "Inject relevant memory context after the first user request in a session"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["gateway:startup", "command"],
        "requires": { "bins": ["node"], "config": ["workspace.dir"] },
      },
  }
---

# Adaptive Memory Hook

Runs on lifecycle + command events:

- `gateway:startup` → warm search cache + refresh cross-session digest
- `command:new` / `command:reset` → compact today's daily memory file + refresh digest
- `command` (regular user flow) → first-message-style memory injection per session,
  using the earliest user request in session history as intent

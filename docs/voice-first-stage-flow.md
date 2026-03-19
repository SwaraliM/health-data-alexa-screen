# Voice-First Narrated Stage Flow

## What changed
- QnA stages are now treated as narrated visual units.
- Each stage is generated and shown one chart at a time.
- Alexa narration is tuned to explain:
  - what is on the screen
  - what stands out
  - what it means
- Stage progression is voice-first (`show more`, `next`, `go back`, `explain that`, `compare that`, `what does this mean`, `start over`).
- Browser stage movement buttons are not used for progression.

## Backend updates
- Executor prompt/config now explicitly enforces older-adult-friendly narration and one-chart-at-a-time output.
- Stage normalization now repairs missing narration structure and standardizes voice-command followups.
- Replay reuses stored narrated stage speech and screen text for deterministic voice behavior.
- Continuation/control intent handling now recognizes broader natural phrases for navigation and interpretation.
- Alexa router normalizes natural control phrases into stable control actions while preserving `/api/alexa` response shape.

## Frontend updates
- QnA visual emphasizes one focused chart stage in voice-first mode.
- Suggested followups are displayed as informational "Say: ..." chips.
- No physical next/back chart navigation controls are required.

## Voice commands users can say
- `show more`
- `next`
- `go back`
- `explain that`
- `compare that`
- `what does this mean`
- `summarize this`
- `start over`
- `tell me more`
- `why is that`
- `what stands out`
- `what am I looking at`

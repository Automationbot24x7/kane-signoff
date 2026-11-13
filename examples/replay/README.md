# Replay the recorded run, without a coding agent

```bash
node examples/replay/replay.mjs           # the checkout spec only, about 8 minutes
node examples/replay/replay.mjs --full    # all three specs, as in the demo video
```

You need Node 18+, Chrome and Kane CLI signed in. No coding agent, no API key.

The replay runs the loop from [the recorded run](../../docs/runs/2026-11-13-recorded-take.md) on your machine:

1. It copies `examples/tabby` to your temp folder and signs the specs.
2. It calls Signoff's **UserPromptSubmit** hook, as Claude Code does when a request starts.
3. It puts [`attempt-1`](attempt-1/public) in place: the files the agent had written when it first said "done".
4. It calls the **Stop** hook. Signoff starts the app and Kane CLI tests it in Chrome. Kane types `NOPE` over `WELCOME10`, sees $120.00 instead of $108.00, and the hook answers `{"decision": "block", "reason": ...}`. The replay prints that reason: it is exactly what the agent reads next.
5. It puts [`attempt-2`](attempt-2/public) in place: the files after the agent's fix.
6. It calls the Stop hook again. Kane passes, and Signoff writes the receipt.

## What is recorded and what is live

| | |
|---|---|
| Played back | The agent's edits. `attempt-1` and `attempt-2` were rebuilt from the recorded run's log by replaying the agent's own file writes and edits; the result matches the files left on disk after that run byte for byte. |
| Live | Signoff's hooks (the same commands Claude Code runs), the app, Kane CLI, Chrome, the evidence pack, the report, the receipt. |

The only difference between the two attempts is the fix in [`app.js`](attempt-2/public/app.js): the page keeps the last valid coupon instead of reading it from the text field.

```bash
diff examples/replay/attempt-1/public/app.js examples/replay/attempt-2/public/app.js
```

Kane CLI is an AI tester, so two runs are never identical. It refused `attempt-1` in every run we made; if it ever passes it for you, the replay says so and exits with code 1.

To run the loop with a real agent instead, see [Try the demo](../../README.md#try-the-demo).

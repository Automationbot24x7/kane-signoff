# Run log: the run in the demo video

**Date:** 13 November 2026, 01:51–02:07 IST · **Project:** a fresh copy of `examples/tabby` · **Specs:** hidden from the agent · **Coding agent:** Claude Code, headless, Haiku model · **Agent cost:** $0.03 · **Kane credits:** 186

This is the unedited run behind the demo video. The video speeds parts of it up and says so on screen; nothing in it was staged or planted.

## Timeline

| Time into the run | What happened |
|---|---|
| 0:19 | The agent's shell command that also read `signoff.config.json` was blocked as a write. That was a false positive in the guard (a `2>/dev/null` redirect counted as a write); it was fixed after this run. |
| 0:26 | The agent tried to open the three hidden specs with its file tool. Signoff blocked each one. |
| 1:44 | The agent finished. Its summary: *"Any other code shows 'That code is not valid.' and changes nothing."* |
| 1:46 | The Stop hook ran. Signoff started the app and Kane CLI took the browser. |
| 3:36 | Kane: `WELCOME10` applied, total $108.00. Passed. |
| 4:00 | Kane typed `NOPE`. The page showed "That code is not valid." and a total of **$120.00**. |
| 10:37 | Round 1 over: the checkout spec failed, the two others passed. The report went back to the agent. |
| 10:47 | The agent: *"Kane's finding is right: typing an invalid code clears the discount that was already applied. The brief says an invalid code 'changes nothing', so I'll track the last valid applied coupon separately from the text in the field."* |
| 11:28 | The agent tried to finish again. Round 2 started. |
| 15:40 | Kane signed off: 3 of 3 specs passed. |

![What Kane saw in round 1](take4-kane-fail.jpg)

*Kane's own screenshot of the failing step.*

## What the agent read after round 1 (verbatim)

```
Kane CLI did not sign off: 1 of 3 specs failed in a real Chrome browser (round 1 of 4).

FAIL  signoff/checkout_test.md
  Kane: [A bad coupon] assert: A message says the code is not valid, and the total still shows $108.00.
  Kane: [A bad coupon] Final verification failed: "A message says the code is not valid, and the total still shows $108.00."
  Bug Kane found: Invalid coupon clears an already applied discount (major, confidence 0.94)
  What Kane saw: Final verification failed: "A message says the code is not valid, and the total still shows $108.00."
  Page: http://localhost:4310/
  Kane's root cause: The coupon entry replaces the previously applied valid coupon before confirming that the replacement code is valid. An invalid replacement should leave the earlier $108.00 total in place.
  Kane's suggested fix: Keep the previously applied coupon and its discount active until a newly entered coupon has been validated successfully. Add a regression test that replaces a valid coupon with an invalid one and verifies that the total remains $108.00.
  Screenshot of what Kane saw (open it): .signoff/rounds/d420aa0a-r1/checkout-f856fecc-step16-screenshot.jpg
  Evidence pack: .testmuai/evidence/320e6136-0ea3-4539-9c33-c8634a90ca3d.evidence

PASS  signoff/edge_test.md

PASS  signoff/split_test.md

Fix the application so it does what these steps describe. The specs themselves are hidden from you on purpose
(like a hold-out test set): work from the brief and the findings above. When you have fixed it, finish again
and Kane will re-run every spec.
```

## The receipt

**Signed off by Kane CLI.** 3/3 specs passed in a real Chrome browser after 2 rounds.

| Spec | Result | Time | Kane credits |
|---|---|---|---|
| `signoff/checkout_test.md` | PASS | 168 s | 42 |
| `signoff/edge_test.md` | PASS (replayed from Kane's cache) | 59 s | 0 |
| `signoff/split_test.md` | PASS (replayed from Kane's cache) | 24 s | 0 |

The agent's change: `public/app.js`, `public/index.html`, `public/style.css` and a `test` script in `package.json` (163 lines added, 19 removed).

## Same bug, five runs

With this ticket and this model, the agent's first version had the same bug in every run we made: 5 of 5. Kane caught it each time. In two of those runs Kane's own triage blamed the spec rather than the app; that is why Signoff now adds a note pointing the agent at the brief when that happens (see `src/report.mjs`).

## Replay it

The files the agent wrote in this run are in [`examples/replay`](../../examples/replay): `attempt-1` is what it had when it first said "done", `attempt-2` is what it had after reading Kane's report. They were rebuilt by replaying the agent's own file writes and edits from this run's log, and the result matches the files left on disk byte for byte.

```bash
node examples/replay/replay.mjs
```

runs both through Signoff's real hooks with your Kane CLI, without a coding agent.

# Signoff

**Your coding agent is not done until Kane signs off.**

Coding agents say "Done!" when the code compiles. Signoff makes "done" mean *a real browser used the app and it worked*. When the agent tries to finish, a Stop hook runs your plain-English [Kane CLI](https://www.testmuai.com/kane-cli/) specs in Chrome. If any spec fails, the agent is not allowed to stop. It gets Kane's diagnosis instead: the bug Kane found, its root cause, the console errors and failed requests at that step, and the screenshot Kane saw. It fixes the code, tries to finish again, and Kane re-runs. Repeat until Kane signs off, or a round cap is hit.

```
agent: "Done! Tip and split are implemented."
   │
   ▼  Stop hook ──► kane-cli testmd run signoff/*_test.md --agent   (real Chrome)
   │
   ├─ FAIL ──► the agent's next instruction is Kane's evidence:
   │             Bug Kane found: shares add up to $114.99, not $115.00
   │             Kane's root cause: each share is rounded down; the lost cent is never assigned
   │             Screenshot of what Kane saw: .signoff/rounds/…/split-step3.jpg
   │           …agent fixes the code, tries to finish again ──► Kane re-runs
   │
   └─ PASS ──► agent may stop. A receipt is written: specs, rounds, credits, Test Manager links.
```

> Built for the KaneCLI Online Hackathon (Nov 12–19, 2026).

## Why this is different from "the agent can call Kane"

The Kane CLI skill lets an agent run Kane *when it decides to*. Signoff takes the decision away:

| | Agent skill | **Signoff** |
|---|---|---|
| Who decides to test | the agent | the hook: every time it tries to finish |
| What happens on a fail | the agent may report it | the agent **cannot stop** until it is fixed |
| What the agent reads | the raw run | a short diagnosis built from Kane's evidence pack (triage, console, network, screenshot) |
| Can the agent weaken the test? | yes | **no**: specs are locked by hash and guarded on write |
| Proof | a run | a receipt per sign-off, a round-by-round ledger, a live timeline |

## Quick start (2 minutes)

You need Node 18+, Chrome, [Kane CLI](https://www.npmjs.com/package/@testmuai/kane-cli) (signed in), and Claude Code.

```bash
npm install -g @testmuai/kane-cli && kane-cli login
cd your-project
npx github:Automationbot24x7/kane-signoff init --url http://localhost:3000 --start "npm run dev"
```

`init` writes:

- `signoff.config.json`: where your app runs and how to start it
- `signoff/smoke_test.md`: a starter spec (edit it, add more)
- `.claude/settings.json`: a **Stop** hook (the gate) and a **PreToolUse** hook (the spec guard)
- `.signoff/tool/`: the gate itself, vendored into your repo with **zero dependencies**, so teammates and CI run the same thing

Then sign the specs and work as usual:

```bash
npx kane-signoff lock     # the specs are now the definition of done
npx kane-signoff view     # optional: watch each round live
```

Ask your agent for a change. It cannot finish until Kane passes the specs.

## Try it on the demo app

`examples/tabby` is a bill splitter with two locked specs and a one-page [brief](examples/tabby/BRIEF.md). The page starts empty.

```bash
cd examples/tabby
node .signoff/tool/bin/kane-signoff.mjs check   # Kane fails both specs: there is no app yet
claude "Build Tabby from BRIEF.md"              # the agent builds; Kane sends it back until the specs pass
```

## Writing specs

A spec is a Kane [`_test.md`](https://github.com/LambdaTest/kane-cli/blob/main/docs/user-guide/testmd/overview.md) file: one `##` heading per step, each step a plain-English objective that ends in a check.

```markdown
---
url: http://localhost:4310
---

# Split a bill

## Add a tip
Type 100 into the bill amount field and choose the 15% tip.
Verify the total shows $115.00.

## Split it three ways
Set the number of people to 3.
Verify the amounts the 3 people pay add up to exactly $115.00, with no cent lost or gained.
```

Passing steps are cached by Kane and replay with no AI cost, so a project that is already green re-checks quickly and cheaply.

## What the agent actually reads

This is a real report from the demo app, before the agent had built anything:

```
Kane CLI did not sign off: 2 of 2 specs failed in a real Chrome browser (round 1 of 4).

FAIL  signoff/split_test.md
  Kane: [Enter the bill] I checked the page and found only a Coming soon message, with no bill amount field.
  Bug Kane found: Test targets unavailable bill-splitting screen (major, confidence 0.93)
  Page: http://localhost:4310/
  Kane's root cause: The test started on a page where the bill-splitting feature is not available …
  Screenshot of what Kane saw (open it): .signoff/rounds/manual-r1/split-69834b04-step1-screenshot.jpg
  Evidence pack: .testmuai/evidence/55992286-….evidence

Fix the application code so these specs pass. Do not edit the specs in the signoff folder: they are
locked, and changing them is rejected. When you have fixed it, finish again and Kane will re-run the specs.
```

## Guard rails

- **Spec lock.** `kane-signoff lock` records a SHA-256 of every spec and the config. If anything changes, by any route, the gate refuses to sign off and tells the agent to restore the specs.
- **Spec guard.** A PreToolUse hook denies file edits and shell writes to `signoff/`, `signoff.config.json`, `.signoff/` and the hook settings, so the agent cannot weaken a test, switch the gate off or forge a pass.
- **Round cap.** After `maxRounds` (default 4) failed rounds the agent is allowed to stop, with the last report and a "not signed off" receipt.
- **Never trapped by infrastructure.** If Kane itself cannot start (exit code 2: sign-in, Chrome, network), the gate lets the agent stop and says why. It only blocks on real failures.
- **No wasted credits.** If the code is byte-for-byte what Kane last signed off, the gate passes without a run. If nothing changed since a failing run, it sends the same report back without spending credits.

## Commands

| Command | What it does |
|---|---|
| `init [--url] [--start]` | wire Signoff into the project |
| `lock` | sign the current specs as the definition of done |
| `check` | run the specs now, like the hook does (exit 0 pass, 1 fail): handy in CI |
| `view` | live round-by-round timeline at `http://localhost:4747` |
| `status` | config, specs, lock state, last sign-off |
| `off` / `on` | pause or resume the gate for this project (humans only: the agent cannot write it) |

## Configuration (`signoff.config.json`)

| Key | Default | |
|---|---|---|
| `url` | `http://localhost:3000` | where the app answers |
| `start` | none | command that starts the app (omit if you run it yourself) |
| `restart` | `true` | restart the app before each round (servers without hot reload) |
| `specs` | `signoff` | folder of `*_test.md` specs |
| `maxRounds` | `4` | failed rounds before the agent may stop anyway |
| `headless` | `true` | set `false` to watch Kane drive Chrome |
| `specTimeout` | `900` | seconds per spec |

## How it works

`bin/kane-signoff.mjs gate` is the Stop hook. It:

1. checks the spec lock;
2. fingerprints the code and skips the run if Kane already signed off on exactly this code;
3. starts (or restarts) the app and waits until it answers;
4. runs each spec with `kane-cli testmd run <spec> --agent`, streaming Kane's NDJSON into the live timeline;
5. on a failure, opens the sealed evidence pack (a zip, read with a built-in reader) and pulls the failing step's `failure.yaml` triage, console errors, failed network calls and screenshot;
6. returns `{"decision":"block","reason": <diagnosis>}` so the diagnosis becomes the agent's next instruction, or lets it stop and writes `.signoff/RECEIPT.md`.

No dependencies. Works on Windows, macOS and Linux.

## License

MIT

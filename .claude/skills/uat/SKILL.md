---
name: uat
description: "Walk me through hands-on acceptance testing of a finished implementation, one step at a time, until every acceptance criterion is confirmed on my end. Works in a fresh session given an issue, PR or branch; ends by opening the PR with the UAT report as a comment."
disable-model-invocation: true
---

Run a **UAT walkthrough**: the user drives the real app; you prepare the data, predict the exact result, and hand over one step at a time. The run is done when every acceptance criterion in the **coverage ledger** is confirmed by the user, fixed and rechecked, or explicitly parked by them.

## 0. Resolve the target

Args may be an issue number, a PR number, or a branch name. If there are no args and nothing was implemented in this session, ask which issue to test and stop.

- Fetch the issue (`gh issue view <n> --comments`), or the PR and its linked issue (`gh pr view <n>`).
- Check out the feature branch. Find the base branch (the PR's base, else the repo default) and confirm it with the user if unsure.
- Read `git log <base>..HEAD` and `git diff <base>...HEAD`.
- Read `.scratch/<issue>/impl-notes.md` if it exists: it records decisions the implementation session made.

Done when you know the issue, the branch, the base, and the full diff.

## 1. Build the coverage ledger

From the issue, the diff, the commit messages and any impl notes, list every acceptance criterion, edge case and stated rule as a ledger row: `criterion → step that proves it → status`. Add rows for behaviour the implementation chose that the spec left open, and flag those as "not in the issue".

Done when every criterion in the spec has a row.

## 2. Collect the environment

Ask in one message for only what is missing: app URL and how to start/restart it, DB connection string, login username/password, and which roles/permissions that account has. Also list any build step the user must run first (codegen, migrations, restart).

Treat these as dev-only values: use them in commands, never write them into committed files or the UAT report.

Done when you can reach the DB and know how the user logs in.

## 3. Seed deliberate data

Inspect what already exists. Design a seed where each record exists to prove one ledger row, including the negatives (records that must *not* appear) and boundaries (exactly at the limit, one over).

- Write `seed.sql` and `cleanup.sql` under `.scratch/<issue>/`.
- Check the seed clashes with nothing already in the DB, then apply it.
- Run the real code path (tests, a query, a small script) against the seeded DB to compute the expected output. Expected values come from that run plus the spec, never from memory.

If the real output disagrees with what the seed was designed to produce, that is a bug: tell the user now, before step 1, and add it to the ledger.

Done when every ledger row has seeded data and a computed expected result.

## 4. Walk one step at a time

Order steps from the default view outward to edge cases, one concern per step. Each message holds exactly one step:

- **## Step N: <concern>** and the precise actions (URL, which filter, which values to type, which button).
- **Expected**: exact values. Use tables for rows and cards, and a "What it checks" column tying each row to its ledger criterion.
- **Should not appear**: the negatives, each with its reason.
- Notes on anything the issue didn't specify.
- End: "Tell me if it matches. Step N+1 will cover <concern>." Then stop and wait.

Accept a screenshot or a description as the answer. On "matches", mark those ledger rows confirmed and send the next step.

## 5. Handle a mismatch

Pin down the exact difference (ask for a screenshot or the value seen). Decide whether the expected value or the code is wrong.

- Code wrong: diagnose (/diagnosing-bugs), write a failing test, fix, run the suite, commit. Then add a **recheck step** showing a Before → Now table and any regenerate/restart needed. Record the bug and fix commit in the ledger.
- Expected value wrong: correct it, say why, and re-run the step.
- A spec gap needing a product decision: ask the user with the options, then act on the answer. Record the decision in the ledger.

## 6. Write the UAT report

Write `.scratch/<issue>/uat-report.md` and show it to the user:

```markdown
## UAT report — #<issue>

**Result:** ✅ All criteria confirmed | ⚠️ Passed with parked items
**Tested on:** <branch> @ <short sha>, <date>

### Acceptance criteria
| # | Criterion | How confirmed | Status |
|---|-----------|---------------|--------|

### Not in the issue
| Behaviour | Decision |
|-----------|----------|

### Bugs found during UAT
| Bug | Fix | Commit |
|-----|-----|--------|

### Parked
- <item> — <reason / follow-up>
```

Leave out empty sections. No credentials, URLs with secrets, or personal data.

## 7. Ship

Offer each step and do it only after the user says go:

1. Commit any remaining generated files.
2. Push the branch.
3. Open the PR to the base branch with `gh pr create`. Body: a short implementation summary built from the diff and commits (what changed, why, notable decisions), `Closes #<issue>`, and how to test. If a PR already exists, update its body only if the user asks.
4. Post the report as its own PR comment: `gh pr comment <pr> --body-file .scratch/<issue>/uat-report.md`.

Finish with the PR link and the cleanup command for the seed (`.scratch/<issue>/cleanup.sql`).

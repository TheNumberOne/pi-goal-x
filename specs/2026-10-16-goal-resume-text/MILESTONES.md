# Milestones: `/goal-resume` optional trailing text

Implementation log.

## Round 1 — implementation (2026-10-16)

- `extensions/goal-commands.ts`: `handleGoalResume` gained an optional
  `rawArgs` parameter. At the top, `const text = (rawArgs ?? "").trim()`
  (whitespace-only = no text); when non-empty, deliver verbatim via
  `core.pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" :
  "steer" })` (same pattern as `goal-drafting.ts:182`), wrapped in try/catch
  with an error notification on throw, then continuing to the resume logic.
- Ordering decision: delivery happens before `reconcileFocusedGoalFromDisk`
  and before every early return (no focused goal, picker cancellation,
  `scheduler.resume` returning false), so user text is never dropped. The
  in-file comment at the delivery block records why: busy path, the steered
  message enters pi's pending queue so `sendQueuedContinuation`
  (`goal-runtime.ts`) waits for it; idle path, the message starts a user
  turn and `agent_start` → `GoalScheduler.begin()` (goal-scheduler.ts)
  cancels the armed kickoff timer. Ordering is best-effort, and if a 0 ms
  kickoff dispatch wins the race the user text is queued as a followUp
  inside that run (no message loss). No resume semantics, messages, or ledger
  events changed.
- Command registration threads `rawArgs` through; the `goal-resume`
  description mentions the optional trailing text.
- README command-table row updated to `/goal-resume <text>` with the
  verbatim-delivery note (one line only).
- Spec directory created (PRODUCT.md behavior, TECH.md touch points,
  this log).
- Tests: new `tests/goal-resume-text.test.ts` (8 tests, sibling palette
  harness pattern with a `sendUserMessage` capturing the `deliverAs`
  option): trimmed text verbatim + `followUp` when idle; `steer` when busy;
  no-arg sends nothing and hits the resume path; whitespace-only sends
  nothing; text still delivered when no goal is focused (early-return path);
  no-arg resume against a paused goal renews the allowance and sends nothing
  (asserts the success notification and `status === "active"`);
  text still delivered when `scheduler.resume()` returns false
  (`maxAutonomousRuns: 0`); a throwing `sendUserMessage` notifies with
  severity `error` and the resume path still runs. Registered the new file
  in `tests/.test-manifest.json` via `--write-manifest` (78 unit entries).
- Review fix (independent review, verdict "OK with notes", no blockers):
  corrected the ordering rationale above — `ctx.hasPendingMessages()` only
  counts queued steer/followUp messages, so it cannot see an idle-time user
  prompt; idle-path ordering is best-effort and protected by
  `agent_start` → `GoalScheduler.begin()` cancelling the armed kickoff
  timer, with an inverted 0 ms dispatch still delivering the text as a
  followUp (no message loss). Reworded the in-file comment, PRODUCT.md,
  TECH.md, and this log accordingly; documented the async-failure
  limitation of the delivery try/catch in TECH.md; added the 3 tests above
  for the previously untested resume-failure and throwing-delivery paths.
- Final validation (re-run after the review fix, environment clean of
  `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_DEPTH`): `npm run check` exit 0;
  `npm test` 1061/1061 pass (8 new); `npm run lint` exit 0; `npm run
  test:selfcheck` exit 0; `node --experimental-strip-types --test
  tests/goal-resume-text.test.ts` 8/8 pass. Note: the suite must be run
  with `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_DEPTH` unset — the subagent
  environment otherwise puts the extension into delegated-goal mode and
  ~228 tests fail for environmental reasons (confirmed identical failures
  on the clean baseline).

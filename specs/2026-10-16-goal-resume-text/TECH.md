# Tech: `/goal-resume` optional trailing text

## Files touched

| File | Change |
| --- | --- |
| `extensions/goal-commands.ts` | `handleGoalResume` gains `rawArgs`; delivery block before resume; command threads `rawArgs`; description updated |
| `README.md` | Command table row mentions optional trailing text |
| `tests/goal-resume-text.test.ts` | Delivery coverage |
| `tests/.test-manifest.json` | New unit entry registered via `--write-manifest` |

## Delivery (`goal-commands.ts`)

At the top of `handleGoalResume`, before `reconcileFocusedGoalFromDisk`:

```ts
const text = (rawArgs ?? "").trim();
if (text) {
  try {
    core.pi.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
  } catch (err) {
    ctx.ui.notify("Could not deliver message to the agent: " + (err instanceof Error ? err.message : String(err)), "error");
  }
}
```

Same delivery pattern as `goal-drafting.ts:182`. Whitespace-only args count
as no text. Delivery precedes every early return (no focused goal, picker
cancellation, `scheduler.resume` returning false) so text is never dropped;
a delivery throw only notifies and continues to resume. The in-file comment
at the delivery block records the ordering rationale: busy path, the steered
message enters pi's pending queue so `sendQueuedContinuation` waits for it;
idle path, the message starts a user turn and `agent_start` →
`GoalScheduler.begin()` cancels the armed kickoff timer — ordering is
best-effort, and an inverted dispatch still delivers the text as a followUp
(no message loss).

Realistic `sendUserMessage` failures (missing model, auth, compaction in
progress) reject asynchronously and surface through pi's own extension-error
channel, not this try/catch notification: the catch only fires for a stale
or uninitialized extension runtime.

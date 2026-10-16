# Rerun completed goals

Completed goals are terminal. `complete` archives the goal file, `/goal-resume` and `/goal-tweak` reject it, and it leaves the open-goal pool. The only way forward today is drafting a new goal from scratch, which loses the task plan, verification contracts, evidence history, budget and audit trail.

This feature adds `/goal-rerun`, which rehydrates a completed goal as an active goal so the entire process — task work, per-task verification, completion audit — runs again. Use cases: a requirement changed after delivery, a regression invalidated the result, a recurring deliverable needs its next iteration, or the user wants the same plan executed against a fresh state.

## Command

- `/goal-rerun` — rerun the focused archived (completed) goal.
- `/goal-rerun <goal-id-or-name>` — rerun a specific completed goal. When several completed goals match or none is focused, offer the selection with confirmation, following the existing `/goal-clear` confirmation pattern.

Before writing, show a bounded summary: objective, previous completion summary, last audit verdict, retained plan shape (task/subtask and contract counts), retained budget and consumed usage, and the archive files that will be preserved.

## Effect

- Status becomes `active` with `autoContinue: true`. The scheduler is re-initialized for the invoking session (fresh owner, zero used runs, no pending wait) and the goal kicks off like a resume.
- Every task and subtask resets to `pending`: recorded evidence, skip reasons and the current-task focus are cleared. Per-task verification contracts are retained, so completion is re-verified requirement by requirement in the new run.
- Objective, goal verification contract, mode (regular/sisyphus), auditor configuration, token budget and lifetime usage are retained. Sisyphus step progress resets to the first step.
- The objective or plan can be edited after rerun through the existing `/goal-tweak` conversation. `/goal-rerun` itself takes no objective argument.
- All previous archive files are preserved untouched; the rerun goal references its full archive history, and `get_goal` history shows earlier audit verdicts alongside the new `goal_rerun` ledger event.
- The completion auditor runs again when completion is requested, as for any active goal.

## Guarantees

- Only `complete` goals are rerunnable. `paused`, `blocked` and `budget_limited` goals continue through `/goal-resume`; cleared goals are disposed and never rerunnable.
- A rerun whose budget is already exhausted stops the goal at `budget_limited` immediately, matching existing budget-recovery semantics; the user raises the limit with `/goal-tweak` before or after the rerun.
- A rerun takes the same per-goal lock and single-session ownership as every other goal transition and is rejected when another session owns the goal.
- All other lifecycle and task rules are unchanged: completed tasks remain immutable under normal flows — only this explicit user command resets them.

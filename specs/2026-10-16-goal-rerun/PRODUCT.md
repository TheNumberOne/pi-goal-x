# Rerun completed goals

Completed goals are terminal. `complete` archives the goal file, `/goal-resume` and `/goal-tweak` reject it, and it leaves the open-goal pool. The only way forward today is drafting a new goal from scratch, which loses the task plan, verification contracts, evidence history, budget and audit trail.

This feature adds `/goal-rerun`, which starts a rerun of a completed goal as a **new sibling goal through the standard guided drafting flow** — the same gathering/refining of requirements, goal questionnaires, proposal and Confirm/Continue-chatting dialog a new goal gets — pre-filled with the previous run's results. The source goal stays complete and archived and is never modified. Use cases: a requirement changed after delivery, a regression invalidated the result, or a recurring deliverable needs its next iteration with tweaks.

## Command

- `/goal-rerun` — no argument: show a selector of completed/archived goals, then a bounded summary with confirmation before drafting starts, following the existing `/goal-clear` confirmation pattern. (Zero completed goals → "No completed goals to rerun.")
- `/goal-rerun <id-or-name>` — an exact goal id, or a substring of the id or objective, first narrows the selector to the matching goals; the selector is then ALWAYS shown (even for a unique match — it doubles as the confirmation step, following the `/goal-clear` pattern), followed by the same bounded summary + confirmation. An argument matching no completed goal is a tweak instead.
- `/goal-rerun <tweak>` — an argument that matches no completed goal is a free-text tweak describing changed requirements. Target resolution is as for the no-argument form (selector); the tweak is applied to the prior objective as the initial seeded change.

The bounded pre-draft summary shows: objective, completion summary, last audit verdict, plan shape (task/subtask and verification-contract counts), token budget and consumed usage, and the archive files that will be preserved. Non-UI hosts are rejected like other confirmation-gated commands: a guidance message, no mutation, no draft started.

## Seeded draft

The draft is seeded from the source goal:

- the prior objective, with the tweak text applied;
- the prior task plan with its per-task verification contracts (editable during drafting);
- the prior goal-level verification contract;
- the prior token budget (carried as the proposed default; the user can change it in the proposal);
- the prior completion/audit results (last audit verdict, report excerpt, consumed usage) as context so the drafter can pre-fill the proposal instead of re-asking.

The full guided process runs unchanged: the drafter may ask `goal_question` / `goal_questionnaire` questions to refine requirements, and the run ends in the standard `propose_goal_draft` proposal with the Confirm / Continue-chatting dialog. The source goal's mode (regular/Sisyphus) is preserved in the new goal.

## Effect (on Confirm)

- A **new active goal** is created with a fresh goal id and the refined objective/plan, usage reset to 0, the carried token budget as a fresh allocation (so run N's exhaustion never blocks run N+1), and provenance referencing the source goal (its goal id and archived path).
- The new goal kicks off with normal new-goal semantics: focused, auto-continue, first run scheduled.
- `get_goal` history/detail for the new goal shows the previous run's summary/verdict and the provenance to the source archive.
- The source goal's archive files are preserved untouched.

## Guarantees

- Only `complete` goals are rerunnable. `paused`, `blocked` and `budget_limited` goals remain `/goal-resume` territory; cleared (disposed) goals are never rerunnable.
- The source goal record and its archive file are never modified, reopened, or re-archived by `/goal-rerun`. The rerun flow is read-only with respect to the source.
- Cancellation at any step (target selector, rerun confirmation, or draft proposal) changes nothing: no goal file, focus entry, ledger entry, or runtime state.
- The rerun sibling is a normal goal: the same per-goal locking, completion audit, budget enforcement, task immutability and scheduler rules apply to it as to any new goal.

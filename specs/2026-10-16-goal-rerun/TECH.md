# Implementation handoff — rerun completed goals (seeded sibling draft)

Target: pi-goal-x v0.32.3 (fork HEAD `64c5ace`, `TheNumberOne/pi-goal-x`). All file:line references below were verified against the current tree (branch `goal-rerun`). The only commit since `64c5ace` is spec commit `c55a96f`, which touched `specs/` only — code line numbers are unchanged from the v0.32.3 tree. Node 24 + `--experimental-strip-types`; run scripts from the repo root.

## 1. Design pivot (supersedes the original spec)

The original design rehydrated the *same* completed goal record in place (status flip, task reset, scheduler re-init, `previousArchives` on the record). The user confirmed on 2026-10-16 a different design: **`/goal-rerun` starts a new sibling goal through the standard guided drafting flow, pre-filled from the completed source goal.** The source goal stays complete/archived and is never modified. No in-place transition of the source record exists anymore — which removes the old design's task-reset, scheduler-replace, and `completedAt`-clearing machinery entirely. What the new design needs instead is a verified walkthrough of the existing drafting pipeline and precise attachment points for seeding. That is Sections 3–4 below.

Finalized decisions (no longer open):

- **D1 — Budget/usage.** Usage resets to 0 on rerun (a new goal gets `emptyUsage()` anyway — see `createGoal`, `extensions/goal-record.ts:222-236`); the source goal's token budget carries over as the new goal's budget — a fresh lifetime allocation, so run N's exhaustion never blocks run N+1.
- **D2 — Tweak.** `/goal-rerun` takes an optional free-text tweak argument; the full guided drafting process runs (`goal_question` / `goal_questionnaire` allowed), ending in the standard proposal + Confirm/Continue-chatting dialog.
- **D3 — Eligibility.** Only `complete` goals are rerunnable; `paused` / `blocked` / `budget_limited` remain `/goal-resume` territory.
- **D4 — Task contracts.** Per-task verification contracts carry over into the new plan as pre-fill (editable during drafting).
- **D5 — Provenance.** The new goal records provenance referencing the source goal (goal id + archived path). Chosen shape in Section 4.5; normalization behavior verified in `extensions/goal-record.ts` (Section 4.5.1).
- **D6 — Kickoff.** Normal new-goal semantics: the run starts after the confirmed draft, nothing special.

## 2. Current terminal-completion behavior (verified)

Still relied upon by the new design (target resolution among archives, guarantees):

- Status set: `"active" | "paused" | "blocked" | "budget_limited" | "complete"` — `extensions/goal-policy.ts:5` (identical union `GoalStatus` at `extensions/goal-record.ts:2`).
- `complete` is rejected by resume: `validateResumeGoal` — `extensions/goal-policy.ts:73-79` (complete rejection at :75: "Goal is complete. Use /goal to draft a new one…"); the scheduler path throws again — `extensions/goal-scheduler.ts:124` ("A completed or token-budget-limited goal cannot resume").
- `complete` is rejected by tweak — `extensions/goal-commands.ts:698` ("Goal is complete. Use /goal to draft a new one…").
- Completion transition: `update_goal(complete)` → `runGoalCompletionFlow` (`extensions/goal-completion.ts:24`) → `core.goalService.apply({mutate: status: "complete"})` at `extensions/goal-completion.ts:95-98`, then the auditor flow (or the `complete_without_audit` user choice at :301).
- Archival is deferred to turn end: the `turn_end` handler archives a complete goal that lacks `archivedPath` — `extensions/goal-events.ts:186-245` (writes `goal_completed` with `archivePath` at :199, then appends `goal_archived` at :219, drops the goal from the pool and unfocuses it; the failure path writes `goal_archive_failed`).
- File layout: active goals under `.pi/goals/`, archives under `.pi/goals/archived/` — `extensions/storage/goal-files.ts:20-21`. The service writes the archived file instead of the active file when status is `complete` — `extensions/goal-service.ts:242-243` and :769, :775; `archiveGoalFile` writes the archive and deletes the active file — `extensions/storage/goal-files.ts:468-479`. `GoalRecord` carries `activePath`/`archivedPath` — `extensions/goal-record.ts:44-45`.
- Per-goal locking: `extensions/storage/goal-lock.ts`, used by `GoalService.apply` (conflict message "deleted or archived by another process" — `extensions/goal-service.ts:470`). The rerun flow never mutates the source, so it needs no source lock; the *created* sibling goes through the standard write path and gets standard locking.
- Goal pool: `goalPoolFromGoals` drops `complete` goals — `extensions/goal-pool.ts:10`; `openGoalsFromPool` — `extensions/goal-pool.ts:18`; session focus resolution also refuses completed goals — `extensions/goal-pool.ts:39-66`. A completed goal therefore never appears in `/goal-list`, `chooseOpenGoal` (`extensions/goal-commands.ts:85`), or as a focus target: rerun target resolution must read the `archived/` directory directly (no pool involvement, Section 4.1).
- Ledger is append-only with a closed event union — `extensions/goal-ledger.ts:10-39` (`goal_created` at :11, `goal_completed` at :22, `goal_archived` at :23, `audit_result` at :20).
- Completed tasks are immutable in every normal flow — `extensions/goal-task-tools.ts:218` ("already complete and cannot be reopened"), `extensions/goal-task-tools.ts:564` (same, for the `status=pending` reopen path).
- Commands register in one block: `extensions/goal-commands.ts:808-930` (`goal` :808, `goal-list` :840, `goal-clear` :890, `goal-resume` :908) — `goal-rerun` slots in here (:896).

## 3. The existing guided drafting pipeline, end to end (verified walkthrough)

This is the path a new goal takes today; the rerun feature attaches to it in Section 4.

1. **Command → draft start.** `/goal <topic>` / `/sisyphus <topic>` handlers — `extensions/goal-commands.ts:717-727` — call `startGoalDrafting(core, ctx, mode, topic)` — `extensions/goal-drafting.ts:138-187`:
   - If a draft is already active, the user picks Resume/Replace/Cancel (`awaitDraftChoice`, `extensions/goal-drafting.ts:124-136`; headless: replace with a warning, :143-145).
   - Auditor default for the draft — global setting, or the target goal's `skipAuditor` for tweaks — `extensions/goal-drafting.ts:163-165`.
   - Registers the in-memory draft (`activeDrafts`, a `WeakMap<GoalCore, ActiveGoalDraft>`, :166), writes a **durable** session entry (`DRAFT_ENTRY = "pi-goal-draft"`, :21-22; `GoalDraftSession` shape :29-38) so the draft survives compaction and tree navigation (:167).
   - Clears continuation/accounting state (:168-169) and installs the transient **drafting tool profile** — `installDraftingToolProfile`, `extensions/goal-state.ts:337-350`, which swaps the execution tool surface for `DRAFTING_GOAL_TOOLS` = `goal_question` + `goal_questionnaire` + `propose_goal_draft` (`extensions/goal-tool-names.ts:24-28`).
   - Sends the drafting prompt as a user message (:182): `goalDraftingPrompt(topic, mode)` for new goals (`extensions/goal-draft.ts:135-196` — the `[GOAL CONFIRMATION focus=goal|sisyphus]` protocol: ask focused questions, targeted read-only research allowed, no implementation before confirmation, include the task list in `propose_goal_draft`, "Confirm creates and focuses the goal; Continue Chatting means keep refining"). Tweak mode instead sends a `[GOAL TWEAK DRAFT]` prompt built inline (`extensions/goal-drafting.ts:172-180`).
2. **Durable rehydration.** On `session_start` and `session_tree` the draft is restored from the branch's last `DRAFT_ENTRY` and the drafting profile re-installed — `rehydrateDraft`, `extensions/goal-drafting.ts:77-122`, called from `extensions/goal-events.ts:273` and :345. A stale tweak draft (target no longer focused) is tombstoned — live memory check :84-87, durable entry :110-118.
3. **Questioning tools.** Registered in `registerDraftingTools` — `extensions/goal-drafting.ts:239-541` (composition: `registerGoalTools`, `extensions/goal-tools.ts:11-16`):
   - `goal_question` (one structured question) — `extensions/goal-drafting.ts:242-267`, executes through `runGoalQuestionnaire` (`extensions/goal-questionnaire.ts:372`); refuses when no draft is active.
   - `goal_questionnaire` (short structured questionnaire) — `extensions/goal-drafting.ts:270-304`; answered Q&A is echoed into the created-goal report (`questionnaireEcho`, E5, :289-293).
   - Dialog-unavailable hosts get `DIALOG_UNAVAILABLE_HINT` and are told to ask in chat — `extensions/goal-questionnaire.ts:360`.
4. **Proposal + confirmation.** `propose_goal_draft` — `extensions/goal-drafting.ts:306-540` (execute block :326-500):
   - Guards: no active draft → reject; budget validation; objective length vs `objectiveMaxChars`; sisyphus-mode gate (`expectedSisyphus = draft.mode === "sisyphus"`, :337-338); task list conversion (`proposedTaskList`, :189-195, depth-bounded by settings); flush + reconcile before the dialog (:341-343).
   - Tweak-only guards: target must still match the draft's `targetGoalId` and not be complete (:344-346). **Budget default**: `proposedBudget = params.token_budget === undefined ? target?.tokenBudget : …` (:349) — for new drafts `target` is undefined, so no budget unless the user proposes one (:350 shows "Current/Proposed" lines only for tweaks).
   - Dialog: `showProposalDialog` with options **Confirm — create this goal now / Continue chatting — keep refining / Cancel — discard this draft** — `extensions/goal-questionnaire.ts:1049-1066`, body text from `proposalText` (`extensions/goal-drafting.ts:197-227`: mode, budget, original topic, proposed objective, then the one task set — explicit, or F2-derived from the objective). Headless / `PI_GOAL_AUTO_CONFIRM=1` auto-confirms instead — `shouldAutoConfirmProposal`, `extensions/goal-questionnaire.ts:289-292`.
   - A durable proposal summary is written for every outcome (confirm/continue/cancel) — `buildProposalSummary`, `extensions/goal-draft.ts:216-228`.
5. **Confirm → goal creation + kickoff.** The confirm branch for non-tweak drafts — `extensions/goal-drafting.ts:398-419`:
   - Task plan: explicit proposal tasks, else F2-derived from the objective (:401-404).
   - `core.replaceGoal({objective, autoContinue, sisyphus, taskList, skipAuditor}, ctx, true, verificationContract, proposedBudget)` — `extensions/goal-state.ts:895-925`:
     - `createGoal` — `extensions/goal-record.ts:222-236`: fresh id (`newGoalId`, base36 timestamp+random, `extensions/goal-record.ts:167-169`), `status: "active"`, `usage: emptyUsage()` (tokensUsed 0), `revision: 0`.
     - Fresh scheduler owned by this session — `newGoalScheduler(ctx.sessionManager.getSessionId())`, `extensions/goal-scheduler-state.ts:29`, assigned at `extensions/goal-state.ts:897`.
     - Verification contract, task list, and token budget attached (:898-900).
     - `goalService.create` — `extensions/goal-service.ts:785-798`: `writeActiveGoalFile` (`extensions/storage/goal-files.ts:455-466`), appends the `goal_created` (+ `task_list_set`) ledger events (`extensions/goal-state.ts:904-911` and :912-918), sets focus to the new goal, tracks the usage baseline, fires `onFocusChanged`.
     - Focus entry `created` (:921), `beginAccounting()` (:922), running notification (:923), then **kickoff**: `if (startNow && state.goal?.autoContinue) scheduler.kickoff(ctx)` — :924 → `GoalScheduler.kickoff`, `extensions/goal-scheduler.ts:135-143` (sets the scheduler phase to `ready`/`kickoff` and schedules the first run; skipped when already in a user run).
   - Draft state cleared, `buildGoalCreatedReport` returned as the tool result, `terminate: true` — `extensions/goal-drafting.ts:406-418` (report builder: `extensions/goal-policy.ts:313-334`; budget line: `formatGoalBudget`, `extensions/goal-policy.ts:309-311`).
6. **Cancel / Continue chatting / unavailable.** Cancel clears the draft, no goal created (:377-379); "continue" keeps drafting active and preserves the user's auditor choice (:384-392); dialog-unavailable leaves drafting active and creates nothing (:381-382).

`/goal-direct` / `/sisyphus-direct` bypass all of the above (`extensions/goal-commands.ts:741-747` → `handleDirectGoalSet`) — rerun deliberately does **not** bypass: the point of the feature is the full guided process.

## 4. Attachment design — where `/goal-rerun` plugs in

New mode `"rerun"` on `GoalDraftMode` (`extensions/goal-drafting.ts:19`), new command `goal-rerun` in the registration block (`extensions/goal-commands.ts:896`), and read-only archived-goal helpers in `extensions/storage/goal-files.ts`. The existing draft-confirmation path is reused unmodified in shape — the sibling goal is created by the same `replaceGoal` call a `/goal` confirm makes.

### 4.1 Target resolution among archived goals (new helpers)

No archived listing/lookup exists today: the only scanner is `scanActiveGoalFiles` (`extensions/storage/goal-files.ts:511-538`), which reads `.pi/goals/`, filters `^active_goal_.*\.md$`, and *excludes* `complete` goals; the pool functions inherit that exclusion (`extensions/goal-pool.ts:10`). Add to `extensions/storage/goal-files.ts`, mirroring :511-538:

- `scanArchivedGoalFiles(ctx)` — readdir `.pi/goals/archived` (`ARCHIVED_GOALS_DIR`, :21), filter `^goal_.*\.md$` (the pattern `makeArchivedGoalPath` produces, :308-310), validate with `isSafeArchivedPath` (:244), parse with `parseGoalFile` (:414), keep only `status === "complete"`, attach `archivedPath` via `sanitizeGoalPaths` (:251), and sort **newest-first** by the filename timestamp (`archivedTimestamp`, :567). The filter is not "inconsistency cleanup": `/goal-clear` archives non-complete goals with `status: "paused"` (`extensions/goal-state.ts:802-805`), which is exactly why the complete-only filter exists (see the comment at `extensions/storage/goal-files.ts:540-545`). Signature is `(ctx)` only (no `root?` param); the command layer bounds display to 20. The resolution result `RerunTargetResolution` (:580) exposes `matches`, the full scan list `all`, `tweak?`, and `total` (total complete archived goals).
- `resolveRerunTarget(ctx, arg)` — arg empty: return all scanned goals. Arg non-empty: exact `id` match, else unique substring match against `id` and `objective`; a non-matching arg returns `{ matches: [], tweak: arg }` (treated as tweak text, target via selector). Ambiguous args (2+ substring matches) return all matches → selector. Goal ids are opaque base36 (`extensions/goal-record.ts:167-169`), so substring matching on objective is the "name" part.

### 4.2 Confirmation (follows `/goal-clear`)

New `handleGoalRerun` in `extensions/goal-commands.ts`, modeled on `handleGoalClear` (:645-682):

1. `resolveRerunTarget`; zero complete archives (`total === 0`) → "No completed goals to rerun." (a non-matching arg is treated as tweak text and goes through the same selector for target selection). **Non-UI rejection comes BEFORE the selector**: `if (!ctx.hasUI)` → notify "Run /goal-rerun in an interactive session to confirm the rerun: <one-line summary>" and return — exactly the `handleGoalClear` pattern at :663 (`extensions/goal-commands.ts:723` precedes the selector at :729-731), so no dialog and no draft can start on a headless host.
2. `ctx.ui.select` selector built like `chooseOpenGoal` (:88; labels via a `chooseRerunSource` line including archivedPath) — shown for EVERY match count, even a single match (`extensions/goal-commands.ts:729-731`), so the user always confirms the target selection explicitly; bounded to the 20 most recently archived goals.
3. Bounded summary + `ctx.ui.confirm("Rerun this goal?", <summary>)` (pattern: `handleGoalClear` :648-670). Cancellation returns with no state change.
4. On confirm: re-scan/re-read the chosen goal from disk (guards against a stale selection), then build the seed (4.3) and call `startGoalDrafting(core, ctx, "rerun", seedText, sourceGoal)`.

The bounded summary (rendered with existing helpers; new builder in `extensions/goal-policy.ts` next to `buildTaskSummary` :85):

- Objective (truncated) — record.
- Completion summary — record-derived: `detailedSummary(sourceGoal)` (`extensions/goal-format.ts:46-78`: status, usage, task summary) plus the last `completion_requested` event's `summary` when present (`extensions/goal-ledger.ts:18`; the current writer at `extensions/goal-completion.ts:56` omits it, so treat as optional).
- Last audit verdict — `latestAuditorResultForGoal(ledgerEvents, sourceId)` (`extensions/goal-ledger.ts:952-960`), ledger from `readGoalLedger` (`extensions/goal-ledger.ts:189`).
- Plan shape — task/subtask counts via `countTaskSubtree` (`extensions/goal-task-count.ts`; used by `buildTaskSummary`) plus a recursive count of tasks carrying `verificationContract`.
- Token budget + consumed usage — `formatGoalBudget` (`extensions/goal-policy.ts:309-311`) + `usageLines` (`extensions/goal-format.ts:39-44`).
- Archive files preserved — `sourceGoal.archivedPath` (one file per goal; if the source itself has `rerunOf`, list the chain's archives too).

### 4.3 Seed context assembly

`startGoalDrafting` (`extensions/goal-drafting.ts:138-187`) gains a `mode === "rerun"` branch:

- **Session records.** `GoalDraftSession` (:29-44) and `ActiveGoalDraft` (:46-60) gain **two** optional fields each, `sourceArchivedPath?: string` and `seedPrompt?: string` (`extensions/goal-drafting.ts:41-43`, :55-57 — set for `mode === "rerun"` only). `targetGoalId` (existing field) carries the **source goal id** in rerun mode. The rendered seed text is NOT stored in `seed` — `seed` keeps the short original topic so the Confirm dialog's "Original Topic" stays small (`extensions/goal-commands.ts:771`); the full multi-KB seed lives in `seedPrompt` only. Optional fields are additive and `rehydrateDraft` tolerates their absence on old durable entries.
- **Seed text** (a new prompt builder in `extensions/goal-draft.ts`, composed from `goalDraftingPrompt`'s common protocol :135-196 with a `[GOAL RERUN DRAFT]` header):
  - Prior objective (full) and the tweak text ("Requested changes: …" when present).
  - Prior task plan: flat render of every task/subtask with title + `verificationContract` (existing `renderConfirmationTasks`, `extensions/goal-task-confirmation.ts`, or a flat variant), marked with the source's final statuses so the drafter knows what was completed/skipped. Contracts are pre-fill, editable.
  - Prior goal-level verification contract.
  - Carried token budget (`formatGoalBudget`).
  - Prior run results: last audit verdict + report excerpt (bounded, e.g. 600 chars — the completion flow's own bound at `extensions/goal-completion.ts:251`), completion summary excerpt, consumed usage.
  - Instructions: pre-fill `propose_goal_draft` from the prior plan/contracts; keep the source mode; keep the budget unless the user asks otherwise; ask `goal_question` / `goal_questionnaire` to refine; the proposal creates a **new sibling goal** — the source archive is preserved and never touched.
- **Auditor default**: global setting (like a new goal), not the source's `skipAuditor` — the existing tweak-only branch at :163-165 must not fire for rerun.
- **Field threading (G1 — the single biggest trap).** The rerun fields must survive EVERY field-by-field durable rebuild of the draft session. There are THREE rebuild sites in `extensions/goal-drafting.ts`: the tombstone in `clearGoalDrafting` (:81 — deliberately drops them: the entry is cleared anyway and re-appending a ≤8 KB seed would bloat the session branch), the rehydrate restore (:135), and the continue-refining rewrite (:454); the fourth durable write (:128) and the memory update (:442-ish) spread, so they are safe. Regression-tested by continue → re-propose → confirm and `sessionTree()` rehydration → confirm.
- **Fallback resolution.** `sourceArchivedPath` is only a fast-path hint: `resolveRerunSourceGoal` (:262) re-reads via `isSafeArchivedPath` + `resolveGoalPath` and falls back to an id-based `scanArchivedGoalFiles` scan (:268) when the hint misses (older durable entries, moved file).

### 4.4 `propose_goal_draft` handling for rerun mode

In the existing execute block (`extensions/goal-drafting.ts:326-500`), rerun differs from `goal` mode in four places:

1. **Sisyphus gate** (:337-338): `expectedSisyphus` comes from the *source* goal's `sisyphus` flag (mode preservation, like tweak), not `draft.mode === "sisyphus"`.
2. **Budget default** (:406): the source goal is the "current" goal for budget purposes — a `budgetCurrent` variable (`extensions/goal-drafting.ts:401`) holds the re-read source record for rerun (it is complete by construction, immutable, so no race semantics needed), making `proposedBudget` default to `source.tokenBudget`; `target` stays tweak-only (:400) and `proposalText`'s budget ternary (:244) had to be extended so rerun shows the same "Current/Proposed" pair tweak does. The `sisyphusObjectiveSufficient` check must fire for rerun when the source was sisyphus (`expectedSisyphus` comes from `rerunSource.sisyphus`, :392).
3. **Tweak-only complete check**: no separate gate was added — `target` is only set in tweak mode (:400), which achieves the same effect (a rerun source is expected to be complete).
4. **Confirm branch**: same path as new drafts, but the `replaceGoal` config additionally carries `rerunOf` (4.5), and the flow guards the source BEFORE the dialog: `rerunSource` is resolved once per proposal (:391) and a missing source aborts before `showProposalDialog` (:411-414) with a message and the draft kept active (the source-missing guard; the source is user-deletable).

Everything else — validation, `showProposalDialog` (:421, label and `proposalText` focus derived from the effective mode at :223 — a Sisyphus-source rerun renders as Sisyphus), durable proposal summary, cancel/continue handling, `clearGoalDrafting`, `buildGoalCreatedReport`, `terminate` — is reused in shape.

### 4.5 Provenance record (D5 — chosen shape)

New on `extensions/goal-record.ts`:

```ts
/** Provenance for a goal created by /goal-rerun from a completed source goal. */
export interface GoalRerunProvenance {
  goalId: string;                        // source goal id
  archivedPath: string;                  // source archive under .pi/goals/archived/
  at: string;                            // ISO time the sibling was created
  summary?: string;                      // snapshot: source completion/audit summary (bounded)
  auditVerdict?: "approved" | "disapproved" | "error";  // snapshot: source's last audit verdict
}
// GoalRecord gains:  rerunOf?: GoalRerunProvenance
// GoalCreationConfig gains:  rerunOf?: GoalRerunProvenance
```

- Snapshot content: `summary` = source's last `audit_result` report truncated to 500 chars (fallback: last `completion_requested.summary`), `auditVerdict` = that `audit_result`'s verdict; both omitted when the source was completed without an audit.
- **Why a single object, not the old `previousArchives: string[]` default:** that shape served in-place rehydration, where one record accumulated archives. A sibling has exactly one direct source; older runs are reached by following `rerunOf` recursively, and the object carries what `get_goal` rendering needs without parsing archive filenames.
- Ledger visibility: add an optional `rerunOf?: string` (source goal id) to the existing `goal_created` variant — `extensions/goal-ledger.ts:11` — and extend its validation case (`isValidLedgerEvent`, `extensions/goal-ledger.ts:689-690`) with `(obj.rerunOf === undefined || typeof obj.rerunOf === "string")`. `replaceGoal`'s `goal_created` event (`extensions/goal-state.ts:904-911`) sets it when present. No new event variant → no changes to the exhaustive type switches in `extensions/goal-activity.ts` (:60, :152-154); `extensions/goal-compaction.ts`'s switch is not exhaustive (it has `default: break;` at :73) and needs no change either. The field automatically appears in `get_goal section=history` (events are JSON-rendered, `extensions/goal-detail.ts:15-43`).

#### 4.5.1 Normalization/versioning verification (why this is safe)

- Goal files wrap the record in a meta block `JSON.stringify({ version: 3, ...goal })` — `extensions/storage/goal-files.ts:334-335` — a full spread, so a new record field is persisted automatically; the file envelope `version: 3` stays valid (optional fields have always been tolerated).
- `GoalRecord` itself has **no** per-field version; `normalizeGoalRecord` (`extensions/goal-record.ts:334-388`) is an **explicit allow-list** — the return object names every persisted field and drops unknowns. Therefore the field must be added in two places: the interface (`extensions/goal-record.ts:56`) and the normalizer's return (:417, beside `archivedPath`), via a `normalizeGoalRerunProvenance` helper (:257-271). **The key is emitted CONDITIONALLY** (`extensions/goal-record.ts:404` + `:417`, `...(rerunOf ? { rerunOf } : {})`, mirroring the `scheduler` spread): an unconditional `rerunOf: undefined` key would break the byte-identical golden fixture (`tests/goal-golden.test.ts:140`) and rewrite historical files. This conditional emission is golden-test-critical.
- Backward compatibility both ways: files without `rerunOf` normalize to absent and are never rewritten (same precedent as `currentTaskId`, :358-364, "Historical files stay absent and are never rewritten just because the field is missing"); new files read by old code simply drop the unknown field.
- `createGoal` (`extensions/goal-record.ts:222-236`) copies `config.rerunOf` onto the new record when present; `replaceGoal` needs no signature change (the provenance rides in `GoalCreationConfig`).

### 4.6 Rendering (get_goal history/detail)

- `buildGoalHistoryBlock` (`extensions/goal-format.ts:329-344`) — when `goal.rerunOf` is set, prepend a provenance line: `Rerun of: <goalId> — archive <archivedPath>` + a conditional `— last audit: <verdict>` clause and a conditional `Prior run:` summary line (`extensions/goal-format.ts:333-337`; both omitted when the snapshot has no verdict/summary). This block is what the `get_goal` summary/verbose views render (`extensions/goal-core-tools.ts:121-124` and :153-156), so the previous run's summary/verdict and provenance show there.
- `goal_created.rerunOf` (4.5) covers `get_goal section=history` and activity/compaction text (optional one-word mention in the `goal_created` case at `extensions/goal-activity.ts:60`; not required).
- The `section=objective`/`tasks` pages need no change.

### 4.7 Kickoff (D6)

Nothing new: the confirmed draft creates the sibling via the same `replaceGoal` call (Section 3, item 5), which focuses it, starts accounting, and kicks off the first run (`extensions/goal-state.ts:924`, `extensions/goal-scheduler.ts:135-143`). The prior budget-exhaustion corner from the old design no longer exists: the sibling starts with usage 0 against the carried budget (D1), so `budgetReached` is false at kickoff by construction.

## Files to touch (expected)

- `extensions/goal-commands.ts` — register `goal-rerun` (:896) in the registration block (:808-930); `handleGoalRerun` (:712; target resolution, selector, bounded summary, confirmation incl. non-UI rejection at :723, then `startGoalDrafting`); `chooseRerunSource` (:689, no focus mutation).
- `extensions/goal-drafting.ts` — `GoalDraftMode` += `"rerun"` (:19); `GoalDraftSession`/`ActiveGoalDraft` `sourceArchivedPath?` + `seedPrompt?` fields (:41-43, :55-57); `startGoalDrafting` rerun branch (auditor default, seed prompt :199-202); `propose_goal_draft` execute: single source resolution + mode-aware sisyphus gate (:391-392), `budgetCurrent` (:401), rerunOf on confirm, source-missing guard before the dialog (:411-414); `proposalText` rerun budget lines (:219-244).
- `extensions/goal-draft.ts` — rerun seed prompt builder (`goalRerunDraftingPrompt`, composed from the shared `commonProtocol` with newline-preserving per-section bounding).
- `extensions/goal-record.ts` — `GoalRerunProvenance` (:36), `GoalRecord.rerunOf?` (:56), `normalizeGoalRecord` pass-through (:334, conditional return :404/:417 via `normalizeGoalRerunProvenance` :257-271), `GoalCreationConfig.rerunOf?` (:158), `createGoal` copy (:248).
- `extensions/goal-state.ts` — `replaceGoal` `goal_created` event carries `rerunOf` (:904-911).
- `extensions/goal-ledger.ts` — `goal_created` optional `rerunOf` field (:11) + validation case (:689-690).
- `extensions/storage/goal-files.ts` — `scanArchivedGoalFiles` + `resolveRerunTarget` (mirror :511-538, :308, :244, :414, :251).
- `extensions/goal-policy.ts` — `validateRerunGoal` (:377, complete-only guard with status-specific messages, mirroring `validateResumeGoal` :73-79), `buildRerunSummary` (:418, bounded pre-draft summary), `buildRerunProvenance` (:449).
- `extensions/goal-format.ts` — conditional provenance lines in `buildGoalHistoryBlock` (:329-344).
- `docs/agent-flow-design.md` — the `goal-rerun` command row in the palette table.
- `tests/` — see below.
- `specs/SPECS.yaml` — status as implementation proceeds (draft → ready_for_review → …).
- README/CHANGELOG: per repo AGENTS.md, do **not** expand the README for this feature; release notes belong in `CHANGELOG.md` at release time.

## Open micro-decisions (recommended defaults; confirm before implementing)

- **Argument grammar.** Recommended: single optional argument that is either a target (exact/unique-substring match) or tweak text (no match → tweak, target via single-completed/selector). Alternative: separate tweak syntax (e.g. second positional arg after a matched id) — rejected as extra grammar for a rare case: the draft conversation already accepts requirement changes through the question flow, and an unmatched arg is unambiguous in practice because goal ids are opaque base36.
- **Provenance snapshot fields** (`summary?`, `auditVerdict?` in `rerunOf`). Recommended: include — `get_goal` rendering stays self-contained (no archive read per call) and survives the user deleting the archive file. Alternative: store only `goalId` + `archivedPath` and read the archive at render time — rejected: extra I/O and a rendering failure mode.
- **`goal_created.rerunOf` ledger field.** Recommended: add (cheap, additive, visible in history/activity). Acceptable fallback: omit it; record-level `rerunOf` alone already satisfies the product requirement.
- **Selector bound.** Recommended: show the 20 most recently archived goals (by `archivedPath` timestamp) with a total count note.

## Tests and validation

Unit tests in `tests/` follow the existing patterns (harness in `tests/goal-core.test.ts`, `tests/goal-drafting.test.ts`, `tests/goal-files.test.ts`):

- **Archived resolution** (`tests/goal-files.test.ts`): `scanArchivedGoalFiles` returns only `complete` goals from `.pi/goals/archived/` (non-complete and malformed files skipped); `resolveRerunTarget` exact-id, unique-substring (id and objective), ambiguous (many), and no-match cases.
- **Record/ledger** (`tests/goal-record.test.ts`, `tests/goal-ledger.test.ts`): `rerunOf` round-trips through normalize + serialize (present kept, absent stays absent and is not added on rewrite); malformed `rerunOf` values dropped safely; `goal_created` with/without `rerunOf` both pass `isValidLedgerEvent`; old ledger lines unaffected.
- **Drafting** (`tests/goal-drafting.test.ts`): rerun seed prompt contains prior objective (+tweak), prior plan with contracts, prior goal contract, carried budget, prior audit verdict/summary; `goal_question` / `goal_questionnaire` work in rerun mode; `propose_goal_draft` in rerun mode — sisyphus gate uses the source mode, budget defaults to the source budget (overridable), confirm creates the sibling (fresh id, `usage.tokensUsed === 0`, carried `tokenBudget`, `rerunOf` populated, source mode preserved) and focuses it; Continue-chatting keeps the draft; cancel creates nothing; confirm with the source archive deleted/moved aborts and keeps the draft.
- **Command/confirmation** (`tests/goal-command-palette.test.ts` or new `tests/goal-rerun.test.ts`): `/goal-rerun` registered; no completed goals → message; single → one-entry selector → summary+confirm; multiple → selector; non-matching arg → treated as tweak + selector; non-UI host → rejection message with no draft started and no file/focus/ledger changes; paused/blocked/budget_limited goals are never offered or accepted (complete-only guard, status-specific messages pointing at `/goal-resume`).
- **Sibling creation + kickoff** (`tests/goal-core.test.ts` harness): confirmed rerun draft → new goal `active` + `autoContinue`, fresh scheduler owned by the session, `goal_created` ledger event with `rerunOf` + `task_list_set`, first run scheduled (kickoff), source goal still `complete` with its archive file byte-identical (archive immutability), source absent from `openGoals` (`extensions/goal-pool.ts:18`) and unfocusable.
- **Task immutability regression** (`tests/goal-task-lifecycle.test.ts`): normal `update_goal_task` flows still refuse to reopen completed tasks (`extensions/goal-task-tools.ts:218, 564`) — rerun never touches the source's tasks; the sibling's copied contracts start `pending`.
- **Rendering** (`tests/goal-status.test.ts` / `tests/goal-core-tools.test.ts`): `get_goal` summary/verbose on the sibling shows the "Rerun of" line (source id, archive path, verdict, bounded summary); `section=history` shows `goal_created.rerunOf`; ledger activity/compaction text renders the event without crashing.

Commands (repo root):

```bash
npm run check        # tsc --noEmit
npm run lint         # eslint
npm test             # scripts/run-unit-tests.mjs (unit)
npm run test:all     # unit + integration
```

The repo also has context-size gates (`npm run context:gate`, `npm run context:provider-check`): the rerun seed prompt extends the *drafting* prompt only (sent via `sendUserMessage` while the drafting profile is active); the execution prompt payloads are unchanged, but verify the gates rather than assume. Manual E2E: `/goal` a small goal → complete it (with auditor) → `/goal-rerun` with a tweak → confirm dashboard, question flow, seeded proposal and confirmation dialog → verify the sibling goal (fresh id, usage 0, carried budget, provenance in `get_goal`), the first run kickoff, and that the source archive file is untouched.

## Provenance

- Requested 2026-10-16 by rose; researched across the pi goal-extension ecosystem (pi.dev catalog, ~64 goal-matching packages) — no off-the-shelf equivalent.
- Design pivot 2026-10-16 (same day, user-confirmed): rerun creates a **new sibling goal via the standard guided drafting flow pre-filled from the source** instead of rehydrating the completed record in place. D1/D2/D6 changed from the original spec defaults (usage resets; tweak argument in the same call; kickoff after confirmed draft); D3/D4 retained; D5 re-designed for the sibling model (Section 4.5).
- Fork: `TheNumberOne/pi-goal-x` ← `tmonk/pi-goal-x` @ v0.32.3. If upstreamed later, PRODUCT.md is the pitch; note upstream maintainers' own spec conventions apply.
- Related history (upstream): #63 (strict execution contracts — the async-wait half of this request, resolved by configuration), #53/#55 (waiting-loop re-queue bugs, fixed), #49 (checkpoint vs forked subagents, fixed in 0.31.1).

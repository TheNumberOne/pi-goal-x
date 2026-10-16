import type { GoalTask, GoalTaskList } from "./goal-record.ts";
import { promptSafeObjective } from "./goal-contract.ts";
import { renderConfirmationTasks } from "./goal-task-confirmation.ts";
import { formatGoalBudget } from "./goal-policy.ts";

export type GoalDraftingFocus = "goal" | "sisyphus";

export interface GoalConfirmationIntentLike {
	focus: GoalDraftingFocus;
	originalTopic: string;
	startedAt?: number;
}

export interface DraftProposalInput {
	intent: GoalConfirmationIntentLike | null;
	hasUnfinishedGoal: boolean;
	objective: string;
	sisyphus?: boolean;
	draftId?: string;
}

export type DraftProposalValidation =
	| { ok: true; objective: string; expectedSisyphus: boolean }
	| { ok: false; message: string; clearDrafting?: boolean };

export type ToolGateDecision =
	| { block: false }
	| { block: true; reason: string };

// ── Shared formatting helpers ──────────────────────────────────────────────
function formatModeLabel(sisyphus: boolean): string {
	return sisyphus ? "Sisyphus (prompt/criteria style)" : "Normal goal";
}

function formatPrefixedLines(content: string): string[] {
	const lines: string[] = [];
	for (const rawLine of content.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("│")) {
			lines.push(rawLine);
		} else {
			lines.push(`│   ${rawLine}`);
		}
	}
	return lines;
}

function formatSection(title: string, content: string): string[] {
	const body = formatPrefixedLines(content);
	return ["", `─── ${title} ───`, "", ...body];
}

export function buildDraftConfirmationText(args: {
	focus: GoalDraftingFocus;
	originalTopic: string;
	objective: string;
	autoContinue: boolean;
}): string {
	const lines: string[] = [];
	lines.push("● Goal draft ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${formatModeLabel(args.focus === "sisyphus")}`);
	lines.push(`│   Auto-continue: ${args.autoContinue ? "yes" : "no"}`);
	lines.push(...formatSection("Original Topic", args.originalTopic.trim()));
	lines.push(...formatSection("Proposed Goal", args.objective));
	return lines.join("\n");
}

export function buildTweakConfirmationText(args: {
	currentObjective: string;
	newObjective: string;
	changeSummary: string;
	sisyphus: boolean;
	tasks?: GoalTask[];
}): string {
	const lines: string[] = [];
	lines.push("● Goal tweak ready for confirmation.");
	lines.push("");
	lines.push("─── Draft Details ───");
	lines.push(`│   Mode: ${formatModeLabel(args.sisyphus)}`);
	lines.push(...formatSection("Change", args.changeSummary));
	lines.push(...formatSection("Current Objective", args.currentObjective));
	lines.push(...formatSection("Proposed New Objective", args.newObjective));
	if (args.tasks && args.tasks.length > 0) {
		const taskLines = renderConfirmationTasks(args.tasks, 0);
		lines.push("");
		lines.push(`┌─ TASKS ─────────────────────────────────────┐`);
		for (const tl of taskLines) lines.push(tl);
		lines.push(`└──────────────────────────────────────────────┘`);
	}
	return lines.join("\n");
}

export function evaluateDraftingToolGate(args: {
	toolName: string;
	draftingFocus?: GoalDraftingFocus | null;
	tweakDraftingGoalId?: string | null;
	activeGoalId?: string | null;
	proposeToolName?: string;
	tweakApplyToolName?: string;
	getGoalToolName?: string;
}): ToolGateDecision {
	// Goal confirmation is prompt-guided, not runtime-enforced. The agent should
	// avoid substantive work before confirmation, but minimal reconnaissance is allowed.
	void args;
	return { block: false };
}

export function validateGoalDraftProposal(input: DraftProposalInput): DraftProposalValidation {
	if (input.intent === null) {
		return {
			ok: false,
			message: "propose_goal_draft REJECTED: no /goal, /sisyphus, or /goal-tweak guided draft is in progress.",
		};
	}

	const expectedSisyphus = input.intent.focus === "sisyphus";
	const actualSisyphus = input.sisyphus === true;
	if (actualSisyphus !== expectedSisyphus) {
		return {
			ok: false,
			message: `propose_goal_draft REJECTED (focus gate): the user invoked ${input.intent.focus === "sisyphus" ? "/sisyphus" : "/goal"} but you passed sisyphus=${actualSisyphus}. Set sisyphus=${expectedSisyphus} to match their choice.`,
		};
	}

	const objective = input.objective.trim();
	if (!objective) {
		return { ok: false, message: "propose_goal_draft REJECTED: objective is empty." };
	}

	return { ok: true, objective, expectedSisyphus };
}

// §rerun-seed: hoisted so goalDraftingPrompt and goalRerunDraftingPrompt share
// the exact same protocol text without duplicating it.
const commonProtocol = [
	"Confirmation protocol:",
	"- Treat this as a lightweight conversation with the user, not a separate long-running runtime phase.",
	"- If the topic is vague, ask one focused question with a recommended default. Use goal_question or goal_questionnaire when a structured answer would help, but plain conversation is acceptable.",
	"- Targeted read-only research is allowed when it helps define a better goal contract; do not start implementation before confirmation.",
	"- If the topic is already concrete, you may proceed directly to propose_goal_draft.",
	"- The goal contract should make the objective, success criteria, boundaries, constraints, and blocker rule explicit.",
	"- Keep grilling assumptions until the objective, success criteria, boundaries, constraints, and blocker rule are clear enough to confirm.",
	"- If the objective naturally decomposes into trackable milestones, you MUST include the task list in the `tasks` parameter of `propose_goal_draft` so the user can accept both goal and tasks in a single confirmation dialog. Do NOT propose the goal without tasks and then call `propose_task_list` separately.",
	"- For simple single-step goals, no task list is required. The `tasks` parameter can be omitted.",
	"- After goal creation, `propose_task_list` is still available for user-requested task additions or structural changes.",
	"- propose_goal_draft opens the user's Confirm / Continue Chatting dialog. Confirm creates and focuses the goal; Continue Chatting means keep refining through normal proposal cycles.",
	"- Call propose_goal_draft with the complete structured proposal. The tool call renderer is the scrollable, complete human presentation of the objective and task tree — do NOT duplicate the full proposal in a preceding prose message. A brief orientation sentence is fine.",
	"- create_goal is not a shortcut. Direct create_goal calls are rejected so the user keeps explicit say in goal creation.",
];

const goalFocusItems = [
	"For /goal, propose a normal goal in this shape when ready:",
	"=== Goal ===",
	"Objective: <one-sentence outcome>",
	"Success criteria: <observable evidence the goal is done>",
	"Boundaries: <in scope / out of scope>",
	"Constraints: <hard rules>",
	"Verification contract: <optional — what verification evidence is required before marking complete, e.g. 'Run npm test (0 failures), grep for remaining references, re-read requirements and confirm every item is addressed'>",
	"If blocked: <default = stop and ask the user>",
	"Call propose_goal_draft with sisyphus=false and autoContinue=true unless the user asked otherwise.",
];

const sisyphusFocusItems = [
	"For /sisyphus, remember that Sisyphus is a prompt/criteria style, not a separate step-counter mechanism.",
	"Propose a Sisyphus goal in this shape when ready:",
	"=== Sisyphus Goal ===",
	"Objective: <one-sentence outcome>",
	"Success criteria: <observable evidence the whole ordered goal is done>",
	"Boundaries: <in scope / out of scope>",
	"Constraints: <hard rules, files not to touch, etc.>",
	"Verification contract: <optional — what verification evidence is required before marking complete>",
	"Ordered steps: <preserve the user's requested steps and ordering; do not add preflight or reconnaissance steps they did not ask for>",
	"If blocked / unclear / failing: <default = stop and ask the user>",
	"Sisyphus reminder: Work patiently and sequentially. No rushing, no unrequested preflight steps, no improvising around blockers.",
	"Call propose_goal_draft with sisyphus=true and autoContinue=true unless the user asked otherwise.",
];

export function goalDraftingPrompt(topic: string, focus: GoalDraftingFocus): string {
	const safeTopic = promptSafeObjective(topic.trim() || "(no topic provided — ask the user what they want to accomplish)");
	const header = focus === "sisyphus"
		? "[GOAL CONFIRMATION focus=sisyphus]\nThe user invoked Sisyphus intent discussion (/sisyphus). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet."
		: "[GOAL CONFIRMATION focus=goal]\nThe user invoked guided goal drafting (/goal). Help turn their request into a confirmed goal contract. Do NOT start substantive work yet.";

	return [
		header,
		"",
		"Topic the user provided:",
		"<goal_topic>",
		safeTopic,
		"</goal_topic>",
		"",
		...commonProtocol,
		"",
		...(focus === "sisyphus" ? sisyphusFocusItems : goalFocusItems),
	].join("\n");
}

/**
 * §rerun-seed: flat render of a source goal's plan for the rerun seed, showing
 * each task's FINAL status in the source run plus its verification contract.
 * Unlike renderConfirmationTasks (which always renders `[ ]` for confirm-time
 * display and is pinned by existing tests), this marks done/skipped tasks so
 * the agent can pre-fill the new plan; the new plan itself starts all-pending.
 */
function renderRerunSourceTasks(tasks: readonly GoalTask[] | undefined, indent = 0): string[] {
	const lines: string[] = [];
	for (const task of tasks ?? []) {
		const marker = task.status === "complete" ? "[x]" : task.status === "skipped" ? "[~]" : "[ ]";
		const contract = task.verificationContract?.trim() ? ` contract: ${task.verificationContract.trim()}` : "";
		const skipped = task.status === "skipped" && task.skipReason?.trim() ? ` — skipped: ${task.skipReason.trim()}` : "";
		lines.push(`${"  ".repeat(indent)}${marker} ${task.title}${contract}${skipped}`);
		lines.push(...renderRerunSourceTasks(task.subtasks, indent + 1));
	}
	return lines;
}

/**
 * §rerun-seed: guided-draft seed for /goal-rerun. Composed from the shared
 * goalDraftingPrompt protocol so the rerun draft behaves like a normal guided
 * draft, but pre-fills the proposal from the completed source run: prior
 * objective + tweak, prior task plan with verification contracts, goal-level
 * contract, carried token budget, and prior audit/completion results.
 */
export function goalRerunDraftingPrompt(args: {
	sourceGoalId: string;
	sourceObjective: string;
	tweak?: string;
	tasks?: GoalTask[];
	verificationContract?: string;
	tokenBudget?: number;
	sisyphus: boolean;
	auditVerdict?: "approved" | "disapproved" | "error";
	auditReportExcerpt?: string;
	completionSummaryExcerpt?: string;
	usageLines: string[];
}): string {
	/** Bounded slice that PRESERVES newlines (never collapses whitespace); the seed is a multi-line prompt. */
	function boundBlock(text: string, max: number): string {
		return text.length > max ? `${text.slice(0, max - 3)}...` : text;
	}
	const safeObjective = boundBlock(promptSafeObjective(args.sourceObjective), 2000);
	const tweak = args.tweak?.trim();
	const header = "[GOAL RERUN DRAFT]\nThe user is rerunning a COMPLETED goal as a NEW sibling goal. The source goal stays complete and archived and is never modified. Do NOT start substantive work yet.";
	const lines: string[] = [
		header,
		"",
		`Source goal id: ${args.sourceGoalId}`,
		"",
		"Prior objective (the full objective of the completed source run):",
		"<prior_objective>",
		safeObjective,
		"</prior_objective>",
		"",
		"Requested changes:",
		tweak ? promptSafeObjective(tweak) : "(none given — ask what should change this run)",
		"",
		"Prior task plan (pre-fill; every contract is editable):",
		// §rerun-seed: bound the heavy sections INDIVIDUALLY (newline-preserving) so the
		// trailing commonProtocol + focus-items blocks always survive; only the final
		// join gets a hard tail cut (truncateText would collapse every newline).
		boundBlock(renderRerunSourceTasks(args.tasks).join("\n"), 4000),
		"(The [x]/[~]/[ ] markers are the SOURCE run's final task statuses; the new plan starts all-pending.)",
		"",
		"Prior goal-level verification contract:",
		args.verificationContract?.trim() || "(none)",
		"",
	];
	if (args.tokenBudget !== undefined) {
		lines.push(
			formatGoalBudget(args.tokenBudget),
			"This budget carries over as a fresh lifetime allocation. OMIT `token_budget` to keep it; set it only if the user asks to change it.",
			"",
		);
	}
	lines.push(
		"Prior run results:",
		`- Last audit: ${args.auditVerdict ?? "none recorded"}`,
		...(args.auditReportExcerpt?.trim() ? [`- Audit report excerpt: ${args.auditReportExcerpt.trim()}`] : []),
		...(args.completionSummaryExcerpt?.trim() ? [`- Completion summary excerpt: ${args.completionSummaryExcerpt.trim()}`] : []),
		`- Consumed usage in the source run: ${args.usageLines.length > 0 ? args.usageLines.join(" | ") : "none"}`,
		"",
		"Instructions:",
		"- Pre-fill propose_goal_draft from the prior plan and contracts instead of re-asking what is already settled.",
		"- You MUST pass the prior plan in the `tasks` parameter unless the user asks to change it; otherwise the sibling gets an objective-derived plan instead of the prior one.",
		`- You MUST pass sisyphus=${args.sisyphus} to match the source goal's mode.`,
		"- Use goal_question / goal_questionnaire to refine changed requirements.",
		"- Confirming creates a NEW sibling goal; the source archive is preserved and never touched.",
		"",
		...commonProtocol,
		"",
		...(args.sisyphus ? sisyphusFocusItems : goalFocusItems),
	);
	// The whole seed is sent as one user message and lands in the transcript — keep it bounded
	// with a hard tail cut that preserves newlines (never truncateText on the joined prompt).
	const seed = lines.join("\n");
	return seed.length > 8000 ? `${seed.slice(0, 7997)}...` : seed;
}


// ── §14 durable proposal summary ─────────────────────────────────────────────

export interface ProposalSummaryArgs {
	objective: string;
	taskList?: GoalTaskList;
	verificationContract?: string;
	autoContinue: boolean;
	auditorEnabled: boolean;
}

/**
 * Durable proposal summary written to the terminal transcript (plan §14):
 * proposed objective, proposed plan (numbered top-level tasks), verification,
 * automatic-continuation state, and auditor state. Produced for every proposal
 * outcome (confirm / continue refining / cancel) so the summary is always part
 * of the conversation, not only the confirmation dialog.
 */
export function buildProposalSummary(args: ProposalSummaryArgs): string {
	const lines: string[] = ["Proposed objective:", args.objective.trim()];
	if (args.taskList && args.taskList.tasks.length > 0) {
		lines.push("", "Proposed plan:");
		lines.push(...renderProposalPlan(args.taskList.tasks));
	}
	if (args.verificationContract?.trim()) {
		lines.push("", "Verification:", args.verificationContract.trim());
	}
	lines.push("", `Automatic continuation: ${args.autoContinue ? "enabled" : "disabled"}`);
	lines.push(`Independent auditor: ${args.auditorEnabled ? "enabled" : "disabled"}`);
	return lines.join("\n");
}

function renderProposalPlan(tasks: GoalTask[]): string[] {
	const lines: string[] = [];
	let index = 1;
	for (const t of tasks) {
		lines.push(`${index}. ${t.title}`);
		if (t.subtasks && t.subtasks.length > 0) {
			for (const child of t.subtasks) {
				lines.push(`   - ${child.title}`);
			}
		}
		index++;
	}
	return lines;
}

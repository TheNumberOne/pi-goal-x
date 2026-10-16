# Milestones

- 2026-10-16: Spec created as an implementation handoff in the `TheNumberOne/pi-goal-x` fork (upstream `tmonk/pi-goal-x` @ v0.32.3, HEAD `64c5ace`), from a direct user request to modify a completed goal and run the entire process again. Not started. The async-waiting half of the same request was resolved without code changes here: operator config `strictExecutionContract: true` (declared waits sleep; the next user message — including pi-subagents completion wakes — auto-resumes) plus prompt-side waiting guidance in the operator's user-wide AGENTS.md.
- All PRODUCT.md behavior and TECH.md file references were verified against the fork tree at creation time; open decisions D1–D6 in TECH.md carry proposed defaults and should be confirmed before implementation begins.

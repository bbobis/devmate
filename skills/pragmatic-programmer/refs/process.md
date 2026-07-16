# Pragmatic Programmer — Process Guidance

> Load when: planning implementation approach, deciding scope, or reviewing workflow habits.

## Think First (Tips 1, 2)
- **Never generate code on autopilot.** Reason about the code before generating it.
- Ask clarifying questions before generating large implementations — unstated requirements are a leading cause of rework.

## Provide Options, Not Excuses (Tip 4)
- When a requested approach can't be done cleanly, always propose **at least one alternative** — never just refuse.

## The Big Picture (Tip 7)
- After each small step, check: *"Am I drifting from the project's goals?"*
- Flag scope creep and architecture erosion when observed.

## Small Steps (Tip 43)
- Take small, reversible steps. Get feedback before the next step.
- Design code to be **replaceable**, not designed for an uncertain future that may never arrive.
- Prefer small reversible steps over large irreversible rewrites.

## Automate Everything (Tips 87–89)
- Any repeated manual step is a candidate for automation.
- CI/CD pipeline must run tests on every commit. Failing tests block merges. No manual deployments.
- Formatting, linting, and static analysis must be automated and enforced by tooling.

## Agility = Feedback (Tip 86)
1. Work out where you are
2. Make the smallest meaningful step toward where you want to be
3. Evaluate where you end up and fix anything broken
4. Repeat

## Listen to Your Instincts (Tip 61)
- When something feels wrong — hard to test, keeps breaking, too many workarounds — **stop and think**.
- The discomfort is data. Do not push through it.

## Estimating (Tip 23)
- Scale estimate units to match accuracy: days for short tasks, weeks for medium, months for long.
- The correct answer when asked for an estimate you haven't thought through: **"I'll get back to you."**

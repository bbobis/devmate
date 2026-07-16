// @ts-check

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseAgentFrontmatter,
  validateAgent,
} from "../../lib/agent-validator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, "../../agents/spec-writer.agent.md");

test("spec-writer agent passes agent validator", async () => {
  const result = await validateAgent(AGENT_PATH);
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
});

test("spec-writer frontmatter enforces deterministic non-user invocation", () => {
  const content = readFileSync(AGENT_PATH, "utf8");
  const frontmatter = parseAgentFrontmatter(content);

  // 'read' was added alongside 'edit' so revision requests can re-read the
  // existing spec.md instead of improvising a scratch-file workaround that
  // gate guard denies (the stuck-loop this agent used to hit).
  assert.deepEqual(frontmatter.tools, ["read", "edit"]);
  assert.equal(frontmatter.name, "spec-writer");
});

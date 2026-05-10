/**
 * Agent skills query handler — read configured skills from `.planning/config.json`
 * and emit the `<agent_skills>` XML block workflows interpolate into Task() prompts.
 *
 * Ports `buildAgentSkillsBlock` semantics from
 * `get-shit-done/bin/lib/init.cjs` so the SDK path honors
 * `config.agent_skills[agentType]` the same way the legacy
 * `gsd-tools.cjs agent-skills <type>` path does. Fixes #2555.
 *
 * @example
 * ```typescript
 * import { agentSkills } from './skills.js';
 *
 * // With config.agent_skills = { "gsd-planner": [".claude/skills/demo-skill"] }
 * await agentSkills(['gsd-planner'], '/project');
 * // { data: '<agent_skills>\nRead these user-configured skills:\n- @.claude/skills/demo-skill/SKILL.md\n</agent_skills>' }
 *
 * // No agent type → empty string (matches gsd-tools cmdAgentSkills).
 * await agentSkills([], '/project');
 * // { data: '' }
 * ```
 */

import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import type { QueryHandler } from './utils.js';
import { loadConfig } from '../config.js';

const GLOBAL_SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Resolve `target` and ensure it stays inside `baseDir` after symlink resolution.
 * Mirrors the symlink-escape guard in `bin/lib/security.cjs#validatePath`.
 */
function resolveWithinBase(target: string, baseDir: string): string | null {
  try {
    const resolvedBase = existsSync(baseDir) ? realpathSync(baseDir) : resolve(baseDir);
    const absTarget = resolve(baseDir, target);
    const resolvedTarget = existsSync(absTarget) ? realpathSync(absTarget) : absTarget;
    const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(baseWithSep)) {
      return null;
    }
    return resolvedTarget;
  } catch {
    return null;
  }
}

export const agentSkills: QueryHandler = async (args, projectDir) => {
  const agentType = (args[0] || '').trim();
  // All empty returns set `format: 'text'` so the CLI dispatcher emits a real
  // empty string (just `\n`) rather than the JSON-quoted literal `""`. The
  // earlier behavior — empty data without `format` — was JSON-stringified to
  // the two-character literal `""`, which workflows then captured into shell
  // variables via `VAR=$(gsd-sdk query agent-skills X)`. Interpolating
  // `${VAR}` into a Task prompt left a literal `""` line in the prompt sent
  // to the spawned subagent (prompt pollution). The earlier test/comment
  // "workflows that embed an empty var are no-ops" was wrong: shell captures
  // the literal `""` characters, not empty.
  if (!agentType) {
    return { data: '', format: 'text' };
  }

  let config;
  try {
    config = await loadConfig(projectDir);
  } catch {
    return { data: '', format: 'text' };
  }

  const raw = config.agent_skills?.[agentType];
  if (!raw) return { data: '', format: 'text' };

  let skillPaths: unknown[];
  if (typeof raw === 'string') {
    skillPaths = [raw];
  } else if (Array.isArray(raw)) {
    skillPaths = raw;
  } else {
    return { data: '', format: 'text' };
  }
  if (skillPaths.length === 0) return { data: '', format: 'text' };

  const globalSkillsBase = join(homedir(), '.claude', 'skills');
  const validEntries: Array<{ ref: string }> = [];

  for (const entry of skillPaths) {
    if (typeof entry !== 'string') continue;

    // `global:<name>` — skill installed under ~/.claude/skills/<name>/ (#1992).
    if (entry.startsWith('global:')) {
      const skillName = entry.slice(7);
      if (!skillName) {
        process.stderr.write('[agent-skills] WARNING: "global:" prefix with empty skill name — skipping\n');
        continue;
      }
      if (!GLOBAL_SKILL_NAME_RE.test(skillName)) {
        process.stderr.write(`[agent-skills] WARNING: Invalid global skill name "${skillName}" — skipping\n`);
        continue;
      }
      const skillDir = join(globalSkillsBase, skillName);
      const skillMd = join(skillDir, 'SKILL.md');
      if (!existsSync(skillMd)) {
        process.stderr.write(`[agent-skills] WARNING: Global skill not found at "~/.claude/skills/${skillName}/SKILL.md" — skipping\n`);
        continue;
      }
      if (resolveWithinBase(skillMd, globalSkillsBase) === null) {
        process.stderr.write(`[agent-skills] WARNING: Global skill "${skillName}" failed path check (symlink escape?) — skipping\n`);
        continue;
      }
      validEntries.push({ ref: `~/.claude/skills/${skillName}/SKILL.md` });
      continue;
    }

    // Project-relative path — must resolve within projectDir.
    if (resolveWithinBase(entry, projectDir) === null) {
      process.stderr.write(`[agent-skills] WARNING: Skipping unsafe path "${entry}"\n`);
      continue;
    }
    const skillMd = join(projectDir, entry, 'SKILL.md');
    if (!existsSync(skillMd)) {
      process.stderr.write(`[agent-skills] WARNING: Skill not found at "${entry}/SKILL.md" — skipping\n`);
      continue;
    }
    validEntries.push({ ref: `${entry}/SKILL.md` });
  }

  if (validEntries.length === 0) return { data: '', format: 'text' };

  const lines = validEntries.map((e) => `- @${e.ref}`).join('\n');
  const block = `<agent_skills>\nRead these user-configured skills:\n${lines}\n</agent_skills>`;
  // Signal the CLI dispatcher to write raw text — workflows embed the result
  // with `$(gsd-sdk query agent-skills …)` and need the XML block verbatim, not
  // a JSON-quoted string (see cli.ts QueryResult.format handling).
  return { data: block, format: 'text' };
};

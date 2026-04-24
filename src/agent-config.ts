// Agent Configuration Loader
// Loads and validates agent YAML configs from the agents/ directory.
import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';

import { AGENTS_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

const RepoSchema = z.object({
  path: z.string(),
  readonly: z.boolean().default(true),
});

const AgentYamlSchema = z.object({
  name: z.string(),
  id: z.string(),
  model: z.string().default('sonnet-4-thinking'),
  description: z.string().default(''),
  skills: z.array(z.string()).default([]),
  repos: z.array(RepoSchema).default([]),
  is_orchestrator: z.boolean().default(false),
  timeout: z.number().default(600000),
  max_concurrent: z.number().default(1),
});

export type AgentYaml = z.infer<typeof AgentYamlSchema>;

export interface AgentConfig extends AgentYaml {
  folder: string;
  claudeMdPath: string;
  jid: string;
}

function resolveHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function loadAgent(agentDir: string): AgentConfig | null {
  const yamlPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(yamlPath)) return null;

  try {
    const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf-8'));
    const parsed = AgentYamlSchema.parse(raw);

    const folder = parsed.id;
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    const jid = `agent:${parsed.id}`;

    return { ...parsed, folder, claudeMdPath, jid };
  } catch (err) {
    logger.warn({ dir: agentDir, err }, 'Failed to load agent config');
    return null;
  }
}

export function loadAllAgents(): AgentConfig[] {
  if (!fs.existsSync(AGENTS_DIR)) {
    logger.debug('No agents/ directory found, skipping agent loading');
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    const agentDir = path.join(AGENTS_DIR, entry);
    if (!fs.statSync(agentDir).isDirectory()) continue;

    const agent = loadAgent(agentDir);
    if (agent) agents.push(agent);
  }

  logger.info(
    { count: agents.length, ids: agents.map((a) => a.id) },
    'Loaded agent configurations',
  );
  return agents;
}

/**
 * Convert an AgentConfig to a RegisteredGroup suitable for NanoClaw's
 * group registration system.
 */
export function agentToGroup(agent: AgentConfig): RegisteredGroup {
  const mounts: AdditionalMount[] = agent.repos.map((repo) => ({
    hostPath: resolveHome(repo.path),
    readonly: repo.readonly,
  }));

  return {
    name: agent.name,
    folder: agent.folder,
    trigger: `@${agent.name}`,
    added_at: new Date().toISOString(),
    containerConfig: {
      additionalMounts: mounts.length > 0 ? mounts : undefined,
      timeout: agent.timeout,
    },
    requiresTrigger: false,
    isMain: agent.is_orchestrator,
  };
}

/**
 * Sync agent CLAUDE.md files into their corresponding group directories.
 * This ensures each agent's group folder has the right memory/instructions.
 */
export function syncAgentMemory(agents: AgentConfig[]): void {
  for (const agent of agents) {
    const groupDir = path.join(GROUPS_DIR, agent.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    if (fs.existsSync(agent.claudeMdPath)) {
      const dest = path.join(groupDir, 'CLAUDE.md');
      fs.copyFileSync(agent.claudeMdPath, dest);
    }
  }
}

/**
 * Generate the routing context section for the orchestrator's CLAUDE.md.
 * Appends an up-to-date agent registry table with skills and repos.
 */
export function generateRoutingContext(agents: AgentConfig[]): string {
  const specialists = agents.filter((a) => !a.is_orchestrator);
  if (specialists.length === 0) return '';

  const lines = [
    '',
    '## Live Agent Registry',
    '',
    '| Agent ID | Skills | Repos |',
    '|----------|--------|-------|',
  ];

  for (const a of specialists) {
    const skills = a.skills.join(', ');
    const repos = a.repos
      .map((r) => path.basename(resolveHome(r.path)))
      .join(', ');
    lines.push(`| ${a.id} | ${skills} | ${repos} |`);
  }

  return lines.join('\n');
}

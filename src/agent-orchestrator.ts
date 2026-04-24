// Agent Orchestrator
// Manages task delegation from orchestrator to specialist agents,
// handles result callbacks, and writes task state to the DB.
import fs from 'fs';
import path from 'path';

import { AGENT_CONTEXT_DIR, DATA_DIR } from './config.js';
import { AgentConfig, generateRoutingContext } from './agent-config.js';
import {
  createAgentTask,
  getAgentTask,
  updateAgentTask,
  AgentTaskEntry,
} from './db.js';
import { broadcastEvent } from './dashboard/server.js';
import { logger } from './logger.js';

export interface DelegateTaskRequest {
  agent_id: string;
  prompt: string;
  context?: string;
  parent_task_id?: string;
  delegated_by?: string;
}

export function generateTaskId(): string {
  return `atask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDelegatedTask(req: DelegateTaskRequest): string {
  const taskId = generateTaskId();
  const now = new Date().toISOString();

  createAgentTask({
    task_id: taskId,
    agent_id: req.agent_id,
    parent_task_id: req.parent_task_id || null,
    prompt: req.prompt,
    status: 'pending',
    result: null,
    delegated_by: req.delegated_by || 'orchestrator',
    started_at: null,
    completed_at: null,
    duration_ms: null,
  });

  broadcastEvent('task_created', {
    taskId,
    agentId: req.agent_id,
    prompt: req.prompt.slice(0, 200),
    timestamp: now,
  });

  logger.info(
    { taskId, agentId: req.agent_id, delegatedBy: req.delegated_by },
    'Delegated task created',
  );

  return taskId;
}

export function markTaskRunning(taskId: string): void {
  const now = new Date().toISOString();
  updateAgentTask(taskId, { status: 'running', started_at: now });
  broadcastEvent('task_started', { taskId, timestamp: now });
}

export function markTaskCompleted(taskId: string, result: string): void {
  const task = getAgentTask(taskId);
  const now = new Date().toISOString();
  const durationMs = task?.started_at
    ? Date.now() - new Date(task.started_at).getTime()
    : null;

  updateAgentTask(taskId, {
    status: 'completed',
    result,
    completed_at: now,
    duration_ms: durationMs,
  });

  broadcastEvent('task_completed', {
    taskId,
    agentId: task?.agent_id,
    timestamp: now,
    durationMs,
  });

  logger.info({ taskId, durationMs }, 'Delegated task completed');
}

export function markTaskFailed(taskId: string, error: string): void {
  const task = getAgentTask(taskId);
  const now = new Date().toISOString();
  const durationMs = task?.started_at
    ? Date.now() - new Date(task.started_at).getTime()
    : null;

  updateAgentTask(taskId, {
    status: 'failed',
    result: error,
    completed_at: now,
    duration_ms: durationMs,
  });

  broadcastEvent('task_failed', {
    taskId,
    agentId: task?.agent_id,
    error,
    timestamp: now,
  });

  logger.warn({ taskId, error }, 'Delegated task failed');
}

// --- Shared context store ---

export function writeAgentContext(
  taskId: string,
  key: string,
  content: string,
): void {
  const dir = path.join(AGENT_CONTEXT_DIR, taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key), content, 'utf-8');
}

export function readAgentContext(taskId: string, key: string): string | null {
  const filePath = path.join(AGENT_CONTEXT_DIR, taskId, key);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function listAgentContext(taskId: string): string[] {
  const dir = path.join(AGENT_CONTEXT_DIR, taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
}

// --- Task result file (IPC-based result passing) ---

const DELEGATION_DIR = path.join(DATA_DIR, 'ipc', '_delegations');

export function writeDelegationRequest(
  taskId: string,
  agentId: string,
  prompt: string,
  context?: string,
): void {
  fs.mkdirSync(DELEGATION_DIR, { recursive: true });
  const data = {
    type: 'delegate_task',
    taskId,
    agentId,
    prompt,
    context: context || '',
    timestamp: new Date().toISOString(),
  };
  const filePath = path.join(DELEGATION_DIR, `${taskId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function readDelegationResult(taskId: string): string | null {
  const filePath = path.join(DELEGATION_DIR, `${taskId}.result.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.result || null;
  } catch {
    return null;
  }
}

export function writeDelegationResult(taskId: string, result: string): void {
  fs.mkdirSync(DELEGATION_DIR, { recursive: true });
  const filePath = path.join(DELEGATION_DIR, `${taskId}.result.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify(
      { taskId, result, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );
  fs.renameSync(tempPath, filePath);
}

export function getPendingDelegations(): Array<{
  taskId: string;
  agentId: string;
  prompt: string;
  context: string;
}> {
  if (!fs.existsSync(DELEGATION_DIR)) return [];

  const files = fs
    .readdirSync(DELEGATION_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));

  const delegations = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(DELEGATION_DIR, file), 'utf-8'),
      );
      if (data.type === 'delegate_task') {
        delegations.push({
          taskId: data.taskId,
          agentId: data.agentId,
          prompt: data.prompt,
          context: data.context || '',
        });
      }
    } catch {
      // skip malformed files
    }
  }
  return delegations;
}

export function removeDelegationRequest(taskId: string): void {
  const filePath = path.join(DELEGATION_DIR, `${taskId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already removed
  }
}

/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Multi-agent orchestration tools ---

const DELEGATION_DIR = path.join(IPC_DIR, '..', '_delegations');
const AGENT_CONTEXT_DIR = process.env.NANOCLAW_AGENT_CONTEXT_DIR || path.join(IPC_DIR, '..', '..', 'agent-context');
const isOrchestrator = process.env.NANOCLAW_IS_ORCHESTRATOR === '1';

server.tool(
  'delegate_task',
  `Delegate a task to a specialist agent. Only available to the orchestrator.
The host will spawn the specialist agent, which works independently and writes its result back.
Use get_task_result to poll for completion.`,
  {
    agent_id: z.string().describe('ID of the specialist agent (e.g., "backend-engineer", "data-streaming-engineer")'),
    prompt: z.string().describe('Detailed instructions for the specialist'),
    context: z.string().optional().describe('Additional context (shared artifacts, decisions from prior subtasks)'),
    parent_task_id: z.string().optional().describe('Parent task ID for subtask tracking'),
  },
  async (args) => {
    if (!isOrchestrator && !isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the orchestrator can delegate tasks.' }],
        isError: true,
      };
    }

    const taskId = `atask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    fs.mkdirSync(DELEGATION_DIR, { recursive: true });
    const data = {
      type: 'delegate_task',
      taskId,
      agentId: args.agent_id,
      prompt: args.prompt,
      context: args.context || '',
      parentTaskId: args.parent_task_id || null,
      delegatedBy: groupFolder,
      timestamp: new Date().toISOString(),
    };
    const filePath = path.join(DELEGATION_DIR, `${taskId}.json`);
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} delegated to ${args.agent_id}. Use get_task_result("${taskId}") to check progress.` }],
    };
  },
);

server.tool(
  'get_task_result',
  'Check the result of a previously delegated task. Returns the result if complete, or the current status.',
  {
    task_id: z.string().describe('The task ID returned by delegate_task'),
  },
  async (args) => {
    const resultPath = path.join(DELEGATION_DIR, `${args.task_id}.result.json`);
    if (fs.existsSync(resultPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        return {
          content: [{ type: 'text' as const, text: `Task ${args.task_id} completed:\n\n${data.result}` }],
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Task ${args.task_id}: result file exists but is malformed.` }],
        };
      }
    }

    const requestPath = path.join(DELEGATION_DIR, `${args.task_id}.json`);
    if (fs.existsSync(requestPath)) {
      return {
        content: [{ type: 'text' as const, text: `Task ${args.task_id} is still in progress. Try again shortly.` }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Task ${args.task_id} not found. It may have been completed and cleaned up, or the ID is incorrect.` }],
    };
  },
);

server.tool(
  'write_agent_context',
  'Write a shared artifact to the context store. Other agents can read this via get_agent_context. Use for sharing schemas, decisions, code snippets between agents.',
  {
    task_id: z.string().describe('Task ID to scope the context to'),
    key: z.string().describe('Artifact name (e.g., "schema.json", "api-spec.yaml", "decisions.md")'),
    content: z.string().describe('The artifact content'),
  },
  async (args) => {
    const dir = path.join(AGENT_CONTEXT_DIR, args.task_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, args.key), args.content, 'utf-8');
    return {
      content: [{ type: 'text' as const, text: `Context artifact "${args.key}" written for task ${args.task_id}.` }],
    };
  },
);

server.tool(
  'get_agent_context',
  'Read a shared artifact from the context store. Returns the content of a previously written artifact, or lists available artifacts if no key is specified.',
  {
    task_id: z.string().describe('Task ID to scope the context to'),
    key: z.string().optional().describe('Artifact name to read. Omit to list available artifacts.'),
  },
  async (args) => {
    const dir = path.join(AGENT_CONTEXT_DIR, args.task_id);
    if (!fs.existsSync(dir)) {
      return {
        content: [{ type: 'text' as const, text: `No context found for task ${args.task_id}.` }],
      };
    }

    if (!args.key) {
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
      if (files.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No artifacts in context for task ${args.task_id}.` }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Available artifacts for task ${args.task_id}:\n${files.map((f) => `- ${f}`).join('\n')}` }],
      };
    }

    const filePath = path.join(dir, args.key);
    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: 'text' as const, text: `Artifact "${args.key}" not found for task ${args.task_id}.` }],
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      content: [{ type: 'text' as const, text: content }],
    };
  },
);

// --- Inter-agent communication + rating tools ---

const CONV_DIR = path.join(IPC_DIR, '..', '_conversations');
const RATINGS_DIR = path.join(IPC_DIR, '..', '_ratings');

server.tool(
  'agent_message',
  'Send a persistent message to another agent. The message is stored and the recipient can read it later via read_agent_messages.',
  {
    to_agent: z.string().describe('ID of the recipient agent'),
    message: z.string().describe('The message content'),
    task_id: z.string().optional().describe('Related task ID for context'),
  },
  async (args) => {
    fs.mkdirSync(CONV_DIR, { recursive: true });
    const data = {
      type: 'agent_message',
      from_agent: groupFolder,
      to_agent: args.to_agent,
      task_id: args.task_id || null,
      message: args.message,
      timestamp: new Date().toISOString(),
    };
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(CONV_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);

    return {
      content: [{ type: 'text' as const, text: `Message sent to ${args.to_agent}.` }],
    };
  },
);

server.tool(
  'read_agent_messages',
  'Read messages sent to this agent by other agents.',
  {
    since: z.string().optional().describe('Only read messages after this ISO timestamp'),
  },
  async (args) => {
    if (!fs.existsSync(CONV_DIR)) {
      return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
    }

    const files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json')).sort();
    const messages = [];

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CONV_DIR, file), 'utf-8'));
        if (data.to_agent === groupFolder) {
          if (args.since && data.timestamp <= args.since) continue;
          messages.push(`[${data.timestamp}] From ${data.from_agent}: ${data.message}`);
        }
      } catch {
        // skip malformed
      }
    }

    if (messages.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No new messages.' }] };
    }

    return {
      content: [{ type: 'text' as const, text: messages.join('\n\n') }],
    };
  },
);

server.tool(
  'rate_task',
  'Rate the quality of a completed task. Used by the orchestrator to evaluate specialist output.',
  {
    task_id: z.string().describe('The task ID to rate'),
    agent_id: z.string().describe('The agent being rated'),
    score: z.number().min(1).max(5).describe('Rating score: 1 (poor) to 5 (excellent)'),
    feedback: z.string().optional().describe('Written feedback about the work'),
    accuracy: z.number().min(1).max(5).optional().describe('Accuracy sub-score'),
    completeness: z.number().min(1).max(5).optional().describe('Completeness sub-score'),
    code_quality: z.number().min(1).max(5).optional().describe('Code quality sub-score'),
  },
  async (args) => {
    fs.mkdirSync(RATINGS_DIR, { recursive: true });

    const criteria: Record<string, number> = {};
    if (args.accuracy) criteria.accuracy = args.accuracy;
    if (args.completeness) criteria.completeness = args.completeness;
    if (args.code_quality) criteria.codeQuality = args.code_quality;

    const data = {
      type: 'rate_task',
      task_id: args.task_id,
      agent_id: args.agent_id,
      rated_by: groupFolder,
      score: args.score,
      feedback: args.feedback || null,
      criteria: Object.keys(criteria).length > 0 ? JSON.stringify(criteria) : null,
      timestamp: new Date().toISOString(),
    };

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(RATINGS_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);

    return {
      content: [{ type: 'text' as const, text: `Rated ${args.agent_id} ${args.score}/5 for task ${args.task_id}.` }],
    };
  },
);

server.tool(
  'get_agent_ratings',
  'Get the rating history for an agent. Useful for understanding agent strengths and routing decisions.',
  {
    agent_id: z.string().describe('The agent ID to look up ratings for'),
  },
  async (args) => {
    if (!fs.existsSync(RATINGS_DIR)) {
      return { content: [{ type: 'text' as const, text: `No ratings found for ${args.agent_id}.` }] };
    }

    const files = fs.readdirSync(RATINGS_DIR).filter((f) => f.endsWith('.json')).sort();
    const ratings = [];
    let totalScore = 0;
    let count = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RATINGS_DIR, file), 'utf-8'));
        if (data.agent_id === args.agent_id) {
          ratings.push(
            `[${data.timestamp}] Score: ${data.score}/5 by ${data.rated_by}` +
            (data.feedback ? ` — ${data.feedback}` : ''),
          );
          totalScore += data.score;
          count++;
        }
      } catch {
        // skip malformed
      }
    }

    if (count === 0) {
      return { content: [{ type: 'text' as const, text: `No ratings found for ${args.agent_id}.` }] };
    }

    const avg = (totalScore / count).toFixed(1);
    return {
      content: [{ type: 'text' as const, text: `Ratings for ${args.agent_id} (avg: ${avg}/5, ${count} ratings):\n\n${ratings.join('\n')}` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

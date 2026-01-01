import { tool } from 'ai';
import { z } from 'zod';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  PIXEL_AGENT_DIR,
  CHARACTER_DIR,
  DB_PATH,
  LOG_PATH,
  OPENCODE_LIVE_LOG,
  AUDIT_LOG_PATH,
  OPENCODE_MODEL
} from './config';
import { logAudit, syncAll } from './utils';

const execAsync = promisify(exec);
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
const CONTINUITY_PATH = isDocker
  ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
  : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');

export const tools = {
  readContinuity: tool({
    description: 'Read the Continuity Ledger. This is the canonical session briefing designed to survive context compaction.',
    inputSchema: z.object({}),
    execute: async () => {
      console.log('[SYNTROPY] Tool: readContinuity');
      try {
        if (!fs.existsSync(CONTINUITY_PATH)) return "Continuity Ledger not found.";
        const content = await fs.readFile(CONTINUITY_PATH, 'utf-8');
        await logAudit({ type: 'continuity_read', content });
        return content;
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  updateContinuity: tool({
    description: 'Update the Continuity Ledger. Use this whenever the goal, constraints, key decisions, or progress state change.',
    inputSchema: z.object({
      content: z.string().describe('The full updated content of CONTINUITY.md. Maintain the standard headings.')
    }),
    execute: async ({ content }) => {
      console.log('[SYNTROPY] Tool: updateContinuity');
      try {
        await fs.writeFile(CONTINUITY_PATH, content);
        await logAudit({ type: 'continuity_update', content });
        return { success: true };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  getEcosystemStatus: tool({
    description: 'Get status of all containers in the ecosystem via Docker',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to perform ecosystem audit')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getEcosystemStatus (Docker)');
      try {
        // Get container status in JSON format
        const { stdout: rawOutput } = await execAsync('docker ps --format "{{json .}}"', { timeout: 10000 });
        const lines = rawOutput.toString().trim().split('\n');

        const status = lines.map(line => {
          try {
            const container = JSON.parse(line);
            return {
              name: container.Names,
              status: container.Status,
              image: container.Image,
              id: container.ID
            };
          } catch (e) {
            return null;
          }
        }).filter(Boolean);

        await logAudit({ type: 'ecosystem_audit', status });
        return status;
      } catch (error: any) {
        await logAudit({ type: 'audit_error', error: error.message });
        return { error: `Docker error: ${error.message}` };
      }
    }
  }),

  readAgentLogs: tool({
    description: 'Read recent logs from the Pixel agent. Automatically filters noise for Syntropy intelligence.',
    inputSchema: z.object({
      lines: z.number().describe('Number of lines to read (e.g. 100)')
    }),
    execute: async ({ lines }) => {
      console.log(`[SYNTROPY] Tool: readAgentLogs (${lines} lines)`);
      try {
        if (fs.existsSync(LOG_PATH)) {
          // Read 5x more lines than requested to have enough data after filtering
          const { stdout: rawLogs } = await execAsync(`tail -n ${lines * 5} ${LOG_PATH}`, { timeout: 10000 });
          const logLines = rawLogs.toString().split('\n');

          const filteredLines = logLines.filter(line => {
            const lowerLine = line.toLowerCase();

            // Priority: Always keep these high-value logs
            if (line.includes('[REFLECTION]') ||
              line.includes('[LORE]') ||
              line.includes('[ZAP]') ||
              line.includes('[DM]') ||
              line.includes('[NOSTR] Replied to') ||
              line.includes('[NOSTR] Reacted to')) {
              return true;
            }

            // Filter out common high-frequency noise
            if (lowerLine.includes('too many concurrent reqs')) return false;
            if (lowerLine.includes('drizzleadapter creatememory')) return false;
            if (lowerLine.includes('creating memory id=')) return false;
            if (lowerLine.includes('connection healthy, last event received')) return false;
            if (lowerLine.includes('stats:') && lowerLine.includes('calls saved')) return false;
            if (lowerLine.includes('invalid iv length')) return false;
            if (lowerLine.includes('skipping old mention')) return false;
            if (lowerLine.includes('event kind 1 from')) return false;

            // Additional filters for better ingestion value
            if (lowerLine.includes('debug')) return false; // DEBUG level logs
            if (lowerLine.includes('notice from')) return false; // Relay notices/errors
            if (lowerLine.includes('bad req:')) return false;
            if (lowerLine.includes('discovery skipping muted user')) return false; // meaningless ids
            if (lowerLine.includes('timeline lore processing deferred')) return false;
            if (lowerLine.includes('llm generation attempt') && lowerLine.includes('failed')) return false; // unless critical
            if (lowerLine.includes('all llm generation retries failed')) return false; // redundant
            if (lowerLine.includes('round') && lowerLine.includes('metrics:')) return false; // unless quality > 0
            if (lowerLine.includes('adaptive threshold activated')) return false;
            if (lowerLine.includes('continuing to round')) return false;
            if (lowerLine.includes('discovery round')) return false;
            if (lowerLine.includes('round topics (fallback):')) return false;
            if (lowerLine.includes('expanded search params:')) return false;
            if (lowerLine.includes('discovery "') && lowerLine.includes('": relevant')) return false; // generic discovery stats
            if (lowerLine.includes('generating text with')) return false; // LLM setup noise
            if (/\b[0-9a-f]{8}\b/.test(line)) return false; // filter lines with meaningless hex ids

            // Filter out large JSON objects (usually context or stats)
            if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
              if (line.length > 500) return false;
            }

            // Filter out empty lines
            if (!line.trim()) return false;

            return true;
          });

          const result = filteredLines.slice(-lines).join('\n');
          await logAudit({ type: 'logs_read', lines, filtered: true });
          return result || "No relevant logs found after filtering.";
        }
        return "Log file not found";
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  checkTreasury: tool({
    description: 'Check the Lightning Network treasury balance (LNPixels DB)',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to check treasury balance')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: checkTreasury');
      let db;
      try {
        if (!fs.existsSync(DB_PATH)) return "Database not found";
        // @ts-ignore
        const { Database } = await import('bun:sqlite');
        db = new Database(DB_PATH);
        const result = db.query('SELECT SUM(sats) as total FROM pixels').get() as any;
        const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get() as any;
        const data = { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
        await logAudit({ type: 'treasury_check', ...data });
        return data;
      } catch (error: any) {
        await logAudit({ type: 'treasury_error', error: error.message });
        return { error: `SQLite error: ${error.message}` };
      } finally {
        if (db) db.close();
      }
    }
  }),

  readPixelMemories: tool({
    description: `Read Pixel's memories from the embedded PGLite database.
ElizaOS stores all data in PGLite (embedded PostgreSQL) at /app/.eliza/.elizadb/ inside the agent container.
The 'memories' table contains ALL agent data with different content types:
- messages: Regular conversation messages (content.source = telegram/nostr/etc)
- self_reflection: Periodic self-analysis with strengths/weaknesses (content.type = 'self_reflection')
- life_milestone: Narrative evolution and phase changes (content.type = 'life_milestone')
- agent_learning: Individual learnings extracted from reflections (content.type = 'agent_learning')
Use 'messages' to see recent conversations, 'reflections' for insights, 'all' for everything.`,
    inputSchema: z.object({
      category: z.enum(['messages', 'reflections', 'all']).describe('Category: messages (conversations), reflections (self_reflection/life_milestone/agent_learning), or all'),
      limit: z.number().optional().describe('Maximum number of results (default: 10)'),
      source: z.string().optional().describe('Filter by source (telegram, nostr) - only for messages category')
    }),
    execute: async ({ category, limit = 10, source }) => {
      console.log(`[SYNTROPY] Tool: readPixelMemories (category=${category}, limit=${limit}, source=${source || 'any'})`);
      try {
        // Build query based on category
        let whereClause: string;
        if (category === 'messages') {
          // Messages don't have content.type set, filter by source if provided
          whereClause = source
            ? `content->>'type' IS NULL AND content->>'source' = '${source}'`
            : `content->>'type' IS NULL`;
        } else if (category === 'reflections') {
          whereClause = `content->>'type' IN ('self_reflection', 'life_milestone', 'agent_learning')`;
        } else {
          whereClause = '1=1'; // all
        }

        const query = `SELECT id, created_at, content FROM memories WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;

        const script = `
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite('/app/.eliza/.elizadb');
db.query(\`${query}\`).then(r => console.log(JSON.stringify(r.rows))).catch(e => console.error('ERROR:', e.message));
`;
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const results = JSON.parse(stdout.trim());

        // Format results based on category
        const memories = results.map((row: any) => {
          const content = row.content || {};
          if (category === 'messages' || !content.type) {
            // Message format: show conversation flow
            return {
              id: row.id,
              createdAt: row.created_at,
              source: content.source,
              text: content.text?.substring(0, 800),
              isReply: !!content.inReplyTo,
              thought: content.thought?.substring(0, 800)
            };
          } else {
            // Reflection format: show insights
            return {
              id: row.id,
              createdAt: row.created_at,
              type: content.type,
              data: content.data || content
            };
          }
        });

        await logAudit({ type: 'pixel_memories_read', category, count: memories.length });
        return { memories, count: memories.length, category };
      } catch (error: any) {
        await logAudit({ type: 'pixel_memories_error', error: error.message });
        return { error: `Failed to read Pixel memories: ${error.message}` };
      }
    }
  }),

  getPixelStats: tool({
    description: "Get statistics about Pixel's memory database - total memories, sources, reflection counts.",
    inputSchema: z.object({}),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getPixelStats');
      try {
        const script = `
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite('/app/.eliza/.elizadb');
Promise.all([
  db.query("SELECT COUNT(*) as total FROM memories"),
  db.query("SELECT content->>'source' as source, COUNT(*) as count FROM memories WHERE content->>'type' IS NULL GROUP BY content->>'source'"),
  db.query("SELECT content->>'type' as type, COUNT(*) as count FROM memories WHERE content->>'type' IS NOT NULL GROUP BY content->>'type'")
]).then(([total, sources, types]) => console.log(JSON.stringify({
  totalMemories: total.rows[0]?.total || 0,
  messagesBySource: sources.rows,
  reflectionsByType: types.rows
}))).catch(e => console.error('ERROR:', e.message));
`;
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const stats = JSON.parse(stdout.trim());
        await logAudit({ type: 'pixel_stats', ...stats });
        return stats;
      } catch (error: any) {
        return { error: `Failed to get Pixel stats: ${error.message}` };
      }
    }
  }),

  readCharacterFile: tool({
    description: 'Read a specific part of Pixel\'s character DNA',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts'])
    }),
    execute: async ({ file }) => {
      try {
        const filePath = path.resolve(CHARACTER_DIR, file);
        return await fs.readFile(filePath, 'utf-8');
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  mutateCharacter: tool({
    description: 'Mutate a specific part of Pixel\'s character DNA. Automatically builds and reboots the agent.',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts']),
      content: z.string().describe('The full content of the file to write')
    }),
    execute: async ({ file, content }) => {
      console.log(`[SYNTROPY] Tool: mutateCharacter (${file})`);
      const filePath = path.resolve(CHARACTER_DIR, file);
      const varName = file.split('.')[0];
      let oldContent = "";

      try {
        // 1. Validation de base
        const exportRegex = new RegExp(`export\\s+(const|let|var)\\s+${varName}\\b`, 'm');
        if (!exportRegex.test(content)) {
          return { error: `Validation failed: Content must export '${varName}'` };
        }

        // 2. Backup old content
        if (fs.existsSync(filePath)) {
          oldContent = await fs.readFile(filePath, 'utf-8');
        }

        await logAudit({ type: 'mutation_start', file });

        // 3. Write new content
        await fs.writeFile(filePath, content);

        try {
          // 4. Validate build ecosystem-wide
          console.log('[SYNTROPY] Validating mutation build...');
          await execAsync('./scripts/validate-build.sh', { cwd: PIXEL_ROOT, timeout: 300000 });

          // 5. Build agent specifically and restart
          await execAsync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
          await execAsync('docker restart pixel-agent-1', { timeout: 20000 });

          await syncAll();
          await logAudit({ type: 'mutation_success', file });
          return { success: true, mutatedFile: file };
        } catch (buildError: any) {
          // 6. Rollback
          console.error(`[SYNTROPY] Mutation build failed: ${buildError.message}. Rolling back...`);
          if (oldContent) {
            await fs.writeFile(filePath, oldContent);
          }
          await logAudit({ type: 'mutation_rollback', file, error: buildError.message });
          return { error: `Mutation failed validation. Reverted to previous stable version. Error: ${buildError.message}` };
        }
      } catch (error: any) {
        return { error: `Mutation process failed: ${error.message}` };
      }
    }
  }),

  writeEvolutionReport: tool({
    description: `Write an evolution report. Use sparingly - only for significant events:
- Successful code mutations or fixes
- Critical errors discovered and resolved  
- Major architectural decisions
- Treasury milestones (e.g., crossed 100k sats)
Do NOT write reports for routine health checks or status updates.`,
    inputSchema: z.object({
      content: z.string().describe('Markdown content of the report'),
      title: z.string().describe('Title of the evolution phase'),
      significance: z.enum(['critical', 'major', 'minor']).describe('How significant is this report? critical=must record, major=important milestone, minor=routine (avoid)')
    }),
    execute: async ({ content, title, significance }) => {
      // Skip minor reports to reduce bloat
      if (significance === 'minor') {
        console.log(`[SYNTROPY] Skipping minor evolution report: ${title}`);
        return { success: true, skipped: true, reason: 'Minor reports are not persisted to reduce bloat' };
      }

      console.log(`[SYNTROPY] Tool: writeEvolutionReport (${title}) [${significance}]`);
      await logAudit({ type: 'evolution_report', title, significance });
      try {
        const reportDir = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/evolution')
          : path.resolve(PIXEL_ROOT, 'docs/evolution');
        await fs.ensureDir(reportDir);
        const filename = `${Date.now()}-${title.toLowerCase().replace(/\\s+/g, '-')}.md`;
        await fs.writeFile(path.resolve(reportDir, filename), content);

        // Auto-prune: Keep only the last 10 reports
        const MAX_REPORTS = 10;
        const files = await fs.readdir(reportDir);
        const mdFiles = files.filter(f => f.endsWith('.md')).sort();
        if (mdFiles.length > MAX_REPORTS) {
          const toDelete = mdFiles.slice(0, mdFiles.length - MAX_REPORTS);
          for (const file of toDelete) {
            await fs.remove(path.resolve(reportDir, file));
            console.log(`[SYNTROPY] Pruned old evolution report: ${file}`);
          }
        }

        const syntropyJsonPath = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/syntropy.json')
          : path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');

        await fs.writeJson(syntropyJsonPath, {
          lastUpdate: new Date().toISOString(),
          title,
          content,
          significance,
          status: 'EVOLUTION_STEP_COMPLETE'
        });
        return { success: true };
      } catch (error: any) {
        await logAudit({ type: 'report_error', title, error: error.message });
        return { error: error.message };
      }
    }
  }),

  delegateToOpencode: tool({
    description: `Delegate a task to the Opencode AI Agent - a powerful background assistant similar to you. 
    
Opencode is an autonomous coding agent that can:
- 🔍 Search the web for latest documentation, solutions, or research
- 💻 Read, analyze, and modify code across the entire codebase  
- 🛠️ Execute shell commands (with sudo access for DevOps tasks)
- 📝 Create files, run tests, debug issues
- 🔧 Perform complex multi-step technical tasks

DELEGATION BEST PRACTICES:
- Be SPECIFIC and DETAILED in your task description
- Include context: what problem you're solving, what you've already tried
- Specify expected output format if needed
- Opencode works autonomously - it may take several minutes for complex tasks

EXAMPLES:
- "Search the web for the latest ElizaOS plugin documentation and summarize the plugin registration API"
- "Audit the pixel-agent logs for the past 24 hours and identify recurring errors"
- "Refactor the nostr plugin to handle connection timeouts gracefully"
- "Check if nginx is configured correctly and fix any issues"

The response summary should be recorded in your Knowledge Base for future reference.`,
    inputSchema: z.object({
      task: z.string().describe('Detailed technical instruction for Opencode. Be specific about what you want done and any constraints.')
    }),
    execute: async ({ task }) => {
      console.log(`[SYNTROPY] Delegating to Opencode Agent (CLI): ${task}`);
      await logAudit({ type: 'opencode_delegation_start', task });

      try {

        // Build context briefing for the dumber model
        const briefing = `
CONTEXT BRIEFING (Read AGENTS.md for full ops reference):
- You are in the Pixel monorepo at /pixel
- Architecture: Docker Compose with services: agent (ElizaOS on :3003), api (:3000), web (:3002), landing (:3001), postgres (:5432), syntropy, nginx
- Agent runtime: Bun + ElizaOS CLI, PostgreSQL database
- Key commands: docker compose [ps|logs|restart|up -d --build] <service>
- Health check: curl http://localhost:3003/health
- Character rebuild: docker compose run --rm agent bun run build:character
- Current state: Read CONTINUITY.md for active tasks and known issues

YOUR TASK: ${task}

Execute this task. Read relevant files first if needed. Use docker compose commands for container ops.`;

        // Ensure log directory exists
        await fs.ensureDir(path.dirname(OPENCODE_LIVE_LOG));
        const logStream = fs.createWriteStream(OPENCODE_LIVE_LOG, { flags: 'a' });

        const timestamp = new Date().toISOString();
        logStream.write(`\n--- DELEGATION START: ${timestamp} ---\nTASK: ${task}\nBRIEFING INJECTED: yes\n\n`);

        // Attach key context files so Opencode can read them
        const agentsMdPath = path.resolve(PIXEL_ROOT, 'AGENTS.md');
        const continuityPath = path.resolve(PIXEL_ROOT, 'CONTINUITY.md');
        const fileFlags = `--file ${agentsMdPath} --file ${continuityPath}`;

        return new Promise((resolve, reject) => {
          const args = [
            'run',
            briefing,
            '-m', OPENCODE_MODEL,
            '--file', agentsMdPath,
            '--file', continuityPath
          ];

          const child = spawn('opencode', args, {
            env: { ...process.env, CI: 'true', OPENCODE_TELEMETRY_DISABLED: 'true' },
            cwd: PIXEL_ROOT
          });

          let fullOutput = '';

          child.stdout.on('data', (data: any) => {
            const str = data.toString();
            fullOutput += str;
            logStream.write(str);
          });

          child.stderr.on('data', (data: any) => {
            const str = data.toString();
            logStream.write(`[STDERR] ${str}`);
          });

          child.on('close', async (code: number) => {
            logStream.write(`\n--- DELEGATION END: ${new Date().toISOString()} (Exit Code: ${code}) ---\n`);
            logStream.end();

            if (code === 0) {
              console.log('[SYNTROPY] Opencode task completed');
              // Try to filter JSON lines if mixed content
              let summary = fullOutput.trim();
              const lines = summary.split('\n');
              const filteredLines = lines.filter((l: string) => !l.startsWith('{') && !l.startsWith('['));
              if (filteredLines.length > 0) {
                summary = filteredLines.join('\n');
              }

              await syncAll(); // Sync code changes
              await logAudit({ type: 'opencode_delegation_success', task, summary: summary.slice(0, 2000) });
              resolve({ success: true, summary: summary.slice(0, 5000) || "Task completed successfully." });
            } else {
              const errorMsg = `Opencode exited with code ${code}`;
              console.error(`[SYNTROPY] Opencode delegation failed: ${errorMsg}`);
              await logAudit({ type: 'opencode_delegation_error', error: errorMsg });
              resolve({ error: `Delegation failed: ${errorMsg}` });
            }
          });

          child.on('error', (err: any) => {
            logStream.write(`[PROCESS ERROR] ${err.message}\n`);
            logStream.end();
            reject(err);
          });
        });

      } catch (error: any) {
        console.error(`[SYNTROPY] Opencode delegation failed: ${error.message}`);
        await logAudit({ type: 'opencode_delegation_error', error: error.message });
        return { error: `Delegation failed: ${error.message}` };
      }
    }
  }),

  notifyHuman: tool({
    description: 'Send a high-priority notification to the human operator. Use this when you are stuck, need a decision, or have a critical breakthrough. It writes to NOTIFICATIONS.md and logs loudly.',
    inputSchema: z.object({
      message: z.string().describe('The message for the human. Be concise and actionable.'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).describe('Priority level.')
    }),
    execute: async ({ message, priority }) => {
      console.log(`[SYNTROPY] 🚨 NOTIFY HUMAN [${priority}]: ${message}`);
      const notificationPath = path.resolve(PIXEL_ROOT, 'NOTIFICATIONS.md');
      const entry = `\n## [${new Date().toISOString()}] Priority: ${priority}\n${message}\n`;

      try {
        await fs.appendFile(notificationPath, entry);
        await logAudit({ type: 'human_notification', message, priority });
        return { success: true, file: 'NOTIFICATIONS.md' };
      } catch (e: any) {
        return { error: e.message };
      }
    }
  }),

  readAudit: tool({
    description: 'Read recent entries from the Syntropy audit log for self-awareness and historical analysis. Reads the most recent entries by default.',
    inputSchema: z.object({
      lines: z.number().optional().describe('Number of recent audit entries to read (default: 50, max: 500)')
    }),
    execute: async ({ lines = 50 }) => {
      console.log(`[SYNTROPY] Tool: readAudit (${lines} entries)`);
      try {
        if (!fs.existsSync(AUDIT_LOG_PATH)) {
          return "Audit log not found.";
        }

        const content = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
        const auditLines = content.trim().split('\n').filter(line => line.trim());

        // Parse and get the most recent entries
        const maxLines = Math.min(Math.max(lines, 1), 500);
        const recentEntries = auditLines.slice(-maxLines).map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            return { parse_error: line.substring(0, 100) + '...' };
          }
        });

        await logAudit({ type: 'audit_read', entries_requested: lines, entries_returned: recentEntries.length });
        return recentEntries;
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  processRefactorQueue: tool({
    description: `Process ONE task from the REFACTOR_QUEUE.md file. This enables autonomous codebase improvement.
    
PROTOCOL:
1. Call with action='check' to see the next available task
2. Call with action='execute' and taskId to process that specific task
3. Only process ONE task per Syntropy cycle to maintain stability

This tool picks up refactoring tasks that break the "spaghetti" codebase into clean modules.
Tasks are designed to be atomic and safe - each has rollback instructions if needed.`,
    inputSchema: z.object({
      action: z.enum(['check', 'execute']).describe("'check' to see next task, 'execute' to run a specific task"),
      taskId: z.string().optional().describe("Task ID to execute (e.g., 'T001'). Required if action='execute'")
    }),
    execute: async ({ action, taskId }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: processRefactorQueue (action=${action}, taskId=${taskId || 'N/A'})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        if (action === 'check') {
          // Find the next READY task
          const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
          const tasks: Array<{ id: string, title: string, status: string }> = [];
          let match;

          while ((match = taskPattern.exec(content)) !== null) {
            tasks.push({ id: match[1], title: match[2], status: match[3] });
          }

          const readyTasks = tasks.filter(t => t.status === '⬜ READY');
          const inProgress = tasks.filter(t => t.status === '🟡 IN_PROGRESS');
          const done = tasks.filter(t => t.status === '✅ DONE');

          if (inProgress.length > 0) {
            return {
              warning: 'A task is already in progress',
              inProgress: inProgress[0],
              message: 'Wait for current task to complete or mark it as DONE/FAILED'
            };
          }

          if (readyTasks.length === 0) {
            return {
              message: 'No READY tasks in queue!',
              stats: { ready: 0, done: done.length, total: tasks.length }
            };
          }

          // Check dependencies for the first ready task
          const nextTask = readyTasks[0];
          const taskSection = content.slice(
            content.indexOf(`### ${nextTask.id}:`),
            content.indexOf(`### T${String(parseInt(nextTask.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
          );

          const dependsMatch = taskSection.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
          let blockedBy: string[] = [];

          if (dependsMatch) {
            const deps = dependsMatch[1].match(/T\d{3}/g) || [];
            const doneTasks = done.map(t => t.id);
            blockedBy = deps.filter(d => !doneTasks.includes(d));
          }

          if (blockedBy.length > 0) {
            // Find next unblocked task
            for (const task of readyTasks.slice(1)) {
              const section = content.slice(
                content.indexOf(`### ${task.id}:`),
                content.indexOf(`### T${String(parseInt(task.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
              );
              const depMatch = section.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
              if (!depMatch) {
                return {
                  nextTask: task,
                  note: `${nextTask.id} is blocked by ${blockedBy.join(', ')}, suggesting ${task.id} instead`,
                  stats: { ready: readyTasks.length, done: done.length }
                };
              }
            }
            return {
              blocked: true,
              nextTask: nextTask,
              blockedBy,
              message: `First ready task ${nextTask.id} is blocked by incomplete dependencies`
            };
          }

          // Extract INSTRUCTIONS block
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          const instructions = instructionsMatch ? instructionsMatch[1].trim() : 'No instructions found';

          return {
            nextTask,
            instructions: instructions.substring(0, 500) + (instructions.length > 500 ? '...' : ''),
            stats: { ready: readyTasks.length, done: done.length, total: tasks.length },
            action: `Call processRefactorQueue with action='execute' and taskId='${nextTask.id}' to process this task`
          };
        }

        if (action === 'execute') {
          if (!taskId) {
            return { error: "taskId is required for action='execute'" };
          }

          // Find the task section
          const taskHeaderPattern = new RegExp(`### ${taskId}: ([^\\n]+) (⬜ READY|🟡 IN_PROGRESS)`);
          const headerMatch = content.match(taskHeaderPattern);

          if (!headerMatch) {
            return { error: `Task ${taskId} not found or not in READY/IN_PROGRESS status` };
          }

          // Extract the full task section
          const taskStart = content.indexOf(`### ${taskId}:`);
          const nextTaskMatch = content.slice(taskStart + 10).match(/### T\d{3}:/);
          const taskEnd = nextTaskMatch ? taskStart + 10 + nextTaskMatch.index! : content.length;
          const taskSection = content.slice(taskStart, taskEnd);

          // Extract INSTRUCTIONS
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          if (!instructionsMatch) {
            return { error: `No INSTRUCTIONS block found for ${taskId}` };
          }
          const instructions = instructionsMatch[1].trim();

          // Extract VERIFY command
          const verifyMatch = taskSection.match(/VERIFY:\n([\s\S]*?)```/);
          const verifyCommand = verifyMatch ? verifyMatch[1].trim() : null;

          // Mark as IN_PROGRESS
          let updatedContent = content.replace(
            `### ${taskId}: ${headerMatch[1]} ${headerMatch[2]}`,
            `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`
          );
          await fs.writeFile(QUEUE_PATH, updatedContent);
          await logAudit({ type: 'refactor_task_start', taskId, title: headerMatch[1] });

          // Delegate to Opencode directly (avoiding circular reference to tools object)
          console.log(`[SYNTROPY] Delegating refactor task ${taskId} to Opencode...`);

          const delegationTask = `REFACTORING TASK ${taskId}: ${headerMatch[1]}

${instructions}

After completing the task:
1. Run the verification command if provided
2. Report success or any errors encountered

VERIFICATION COMMAND:
${verifyCommand || 'No verification specified - manually confirm changes work'}`;

          // Call opencode directly
          const agentsMdPath = path.resolve(PIXEL_ROOT, 'AGENTS.md');
          const continuityPath = path.resolve(PIXEL_ROOT, 'CONTINUITY.md');

          let delegationSuccess = false;
          let delegationSummary = '';

          try {
            const delegationArgs = [
              'run',
              delegationTask,
              '-m', OPENCODE_MODEL,
              '--file', agentsMdPath,
              '--file', continuityPath
            ];

            const child = spawn('opencode', delegationArgs, {
              cwd: PIXEL_ROOT,
              env: { ...process.env, CI: 'true', OPENCODE_TELEMETRY_DISABLED: 'true' }
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data: any) => { stdout += data.toString(); });
            child.stderr.on('data', (data: any) => { stderr += data.toString(); });

            const code = await new Promise<number>((resolve) => {
              child.on('close', resolve);
            });

            delegationSuccess = code === 0;
            delegationSummary = stdout.substring(0, 2000);
            if (stderr) {
              delegationSummary += `\n[STDERR]: ${stderr.substring(0, 500)}`;
            }
          } catch (execError: any) {
            delegationSuccess = false;
            delegationSummary = `Execution failed: ${execError.message}`;
          }

          // Update status based on result
          const finalContent = await fs.readFile(QUEUE_PATH, 'utf-8');
          const newStatus: string = delegationSuccess ? '✅ DONE' : '❌ FAILED';

          const finalUpdatedContent = finalContent.replace(
            `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`,
            `### ${taskId}: ${headerMatch[1]} ${newStatus}`
          );

          // Update Last Processed timestamp
          const timestampUpdated = finalUpdatedContent.replace(
            /\*\*Last Processed\*\*: .*/,
            `**Last Processed**: ${new Date().toISOString()} (${taskId})`
          );

          await fs.writeFile(QUEUE_PATH, timestampUpdated);
          await syncAll(); // Sync any code changes made
          await logAudit({
            type: 'refactor_task_complete',
            taskId,
            success: delegationSuccess,
            summary: delegationSummary.substring(0, 500)
          });
          return {
            taskId,
            status: newStatus,
            success: delegationSuccess,
            summary: delegationSummary
          };
        }

        return { error: 'Invalid action' };
      } catch (error: any) {
        await logAudit({ type: 'refactor_queue_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  addRefactorTask: tool({
    description: `Add a NEW atomic refactoring task to REFACTOR_QUEUE.md. Use this when you discover:
- Code quality issues that should be fixed
- Large files that need splitting
- Missing tests that should be added
- Documentation gaps
- Duplicate code that should be consolidated
- New features that require architectural prep

GUIDELINES FOR GOOD TASKS:
1. ATOMIC: Completable in one Opencode session (5-30 minutes)
2. SPECIFIC: Clear instructions, not vague like "improve code"
3. SAFE: Include verification command to confirm success
4. DEPENDENCY-AWARE: If task depends on others, specify them

The task will be appended to the queue with the next available ID.`,
    inputSchema: z.object({
      title: z.string().describe("Short title (e.g., 'Extract payment routes')"),
      phase: z.string().describe("Which phase/section (e.g., 'Phase 2: API Routes' or 'Phase 4: New Tasks')"),
      effort: z.string().describe("Estimated effort (e.g., '20 min', '1 hour')"),
      risk: z.enum(['None', 'Low', 'Medium', 'High']).describe("Risk level of this change"),
      parallelSafe: z.boolean().describe("Can this task run in parallel with others?"),
      depends: z.string().optional().describe("Task IDs this depends on (e.g., 'T024' or 'T024, T025')"),
      instructions: z.string().describe("Detailed step-by-step instructions for Opencode"),
      verifyCommand: z.string().describe("Shell command to verify success (e.g., 'npm test')")
    }),
    execute: async ({ title, phase, effort, risk, parallelSafe, depends, instructions, verifyCommand }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: addRefactorTask (${title})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        // Find the highest task ID
        const taskIds = content.match(/### T(\d{3}):/g) || [];
        const maxId = taskIds.reduce((max, id) => {
          const num = parseInt(id.match(/T(\d{3})/)?.[1] || '0');
          return Math.max(max, num);
        }, 0);

        const newTaskId = `T${String(maxId + 1).padStart(3, '0')}`;

        // Find or create the phase section
        const phaseHeader = `## 📋 ${phase}`;
        let insertPosition: number;

        if (content.includes(phaseHeader)) {
          // Find the end of this phase section (before next ## or end of file)
          const phaseStart = content.indexOf(phaseHeader);
          const nextSection = content.slice(phaseStart + phaseHeader.length).search(/\n## /);
          insertPosition = nextSection === -1
            ? content.length
            : phaseStart + phaseHeader.length + nextSection;
        } else {
          // Create new phase section at the end, before any footer content
          const footerMatch = content.match(/\n---\n\n\*This queue/);
          insertPosition = footerMatch?.index || content.length;
        }

        // Build the new task block
        const dependsLine = depends ? `\n**Depends**: ${depends}` : '';
        const newTask = `

### ${newTaskId}: ${title} ⬜ READY
**Effort**: ${effort} | **Risk**: ${risk} | **Parallel-Safe**: ${parallelSafe ? '✅' : '❌'}${dependsLine}

\`\`\`
INSTRUCTIONS:
${instructions}

VERIFY:
${verifyCommand}
\`\`\`

---
`;

        // Insert the task
        let newContent: string;
        if (!content.includes(phaseHeader)) {
          // Add new phase section
          const newPhase = `\n${phaseHeader}\n${newTask}`;
          newContent = content.slice(0, insertPosition) + newPhase + content.slice(insertPosition);
        } else {
          newContent = content.slice(0, insertPosition) + newTask + content.slice(insertPosition);
        }

        // Update the READY count in the status table
        const readyCount = (newContent.match(/⬜ READY/g) || []).length;
        newContent = newContent.replace(
          /\| ⬜ READY \| \d+ \|/,
          `| ⬜ READY | ${readyCount} |`
        );

        await fs.writeFile(QUEUE_PATH, newContent);
        await logAudit({
          type: 'refactor_task_added',
          taskId: newTaskId,
          title,
          phase,
          risk
        });

        return {
          success: true,
          taskId: newTaskId,
          title,
          phase,
          message: `Task ${newTaskId} added to queue. Total READY tasks: ${readyCount}`
        };
      } catch (error: any) {
        await logAudit({ type: 'refactor_task_add_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  analyzeForRefactoring: tool({
    description: `Analyze the codebase to discover potential refactoring opportunities. Use this to intelligently grow the refactor queue.

This tool will scan for common issues:
- Large files (>500 lines)
- Deeply nested code
- Duplicate patterns
- Missing test coverage
- Outdated dependencies

Returns suggestions that you can then add via 'addRefactorTask'.`,
    inputSchema: z.object({
      target: z.enum(['plugin-nostr', 'syntropy-core', 'lnpixels-api', 'all']).describe("Which component to analyze"),
      focusArea: z.enum(['file-size', 'complexity', 'test-coverage', 'dependencies', 'all']).describe("What aspect to focus on")
    }),
    execute: async ({ target, focusArea }) => {
      console.log(`[SYNTROPY] Tool: analyzeForRefactoring (${target}, ${focusArea})`);

      try {
        const suggestions: Array<{
          file: string;
          issue: string;
          suggestion: string;
          effort: string;
          priority: string;
        }> = [];

        // Define target paths
        const targetPaths: Record<string, string> = {
          'plugin-nostr': path.resolve(PIXEL_ROOT, 'pixel-agent/plugin-nostr/lib'),
          'syntropy-core': path.resolve(PIXEL_ROOT, 'syntropy-core/src'),
          'lnpixels-api': path.resolve(PIXEL_ROOT, 'lnpixels/api/src'),
          'all': PIXEL_ROOT
        };

        const scanPath = targetPaths[target];

        // File size analysis
        if (focusArea === 'file-size' || focusArea === 'all') {
          try {
            const { stdout } = await execAsync(
              `find ${scanPath} -name "*.js" -o -name "*.ts" | xargs wc -l 2>/dev/null | sort -rn | head -10`,
              { timeout: 30000 }
            );

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const match = line.trim().match(/^(\d+)\s+(.+)$/);
              if (match && parseInt(match[1]) > 500 && !match[2].includes('node_modules') && !match[2].includes('total')) {
                const lineCount = parseInt(match[1]);
                const filePath = match[2];
                const fileName = path.basename(filePath);

                suggestions.push({
                  file: filePath.replace(PIXEL_ROOT, ''),
                  issue: `Large file: ${lineCount} lines`,
                  suggestion: `Split ${fileName} into smaller focused modules`,
                  effort: lineCount > 2000 ? '2-4 hours' : lineCount > 1000 ? '1-2 hours' : '30-60 min',
                  priority: lineCount > 2000 ? 'High' : lineCount > 1000 ? 'Medium' : 'Low'
                });
              }
            }
          } catch (e) {
            // File analysis failed, continue
          }
        }

        // Test coverage analysis
        if (focusArea === 'test-coverage' || focusArea === 'all') {
          try {
            // Find source files without corresponding test files
            const { stdout: srcFiles } = await execAsync(
              `find ${scanPath} -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v test | grep -v ".test." | head -20`,
              { timeout: 15000 }
            );

            for (const srcFile of srcFiles.trim().split('\n').filter(Boolean)) {
              const baseName = path.basename(srcFile).replace(/\.(ts|js)$/, '');
              const testDir = path.dirname(srcFile).replace('/src', '/test');
              const testFile1 = path.join(testDir, `${baseName}.test.js`);
              const testFile2 = path.join(testDir, `${baseName}.test.ts`);

              if (!fs.existsSync(testFile1) && !fs.existsSync(testFile2)) {
                suggestions.push({
                  file: srcFile.replace(PIXEL_ROOT, ''),
                  issue: 'No test file found',
                  suggestion: `Create test file for ${baseName}`,
                  effort: '30-60 min',
                  priority: 'Medium'
                });
              }
            }
          } catch (e) {
            // Test analysis failed, continue
          }
        }

        await logAudit({
          type: 'refactoring_analysis',
          target,
          focusArea,
          suggestionsCount: suggestions.length
        });

        return {
          target,
          focusArea,
          suggestionsCount: suggestions.length,
          suggestions: suggestions.slice(0, 10), // Limit to top 10
          nextStep: suggestions.length > 0
            ? "Review suggestions and use 'addRefactorTask' to add worthy items to the queue"
            : "No obvious refactoring opportunities found in this area"
        };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  })
};

import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT, PIXEL_AGENT_DIR, CHARACTER_DIR, DB_PATH, LOG_PATH, AUDIT_LOG_PATH } from './config';
import { logAudit, syncAll } from './utils';
import { workerTools } from './worker-tools';
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
                if (!fs.existsSync(CONTINUITY_PATH))
                    return "Continuity Ledger not found.";
                const content = await fs.readFile(CONTINUITY_PATH, 'utf-8');
                await logAudit({ type: 'continuity_read', content });
                return content;
            }
            catch (error) {
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
            }
            catch (error) {
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
                    }
                    catch (e) {
                        return null;
                    }
                }).filter(Boolean);
                await logAudit({ type: 'ecosystem_audit', status });
                return status;
            }
            catch (error) {
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
                        if (lowerLine.includes('too many concurrent reqs'))
                            return false;
                        if (lowerLine.includes('drizzleadapter creatememory'))
                            return false;
                        if (lowerLine.includes('creating memory id='))
                            return false;
                        if (lowerLine.includes('connection healthy, last event received'))
                            return false;
                        if (lowerLine.includes('stats:') && lowerLine.includes('calls saved'))
                            return false;
                        if (lowerLine.includes('invalid iv length'))
                            return false;
                        if (lowerLine.includes('skipping old mention'))
                            return false;
                        if (lowerLine.includes('event kind 1 from'))
                            return false;
                        // Additional filters for better ingestion value
                        if (lowerLine.includes('debug'))
                            return false; // DEBUG level logs
                        if (lowerLine.includes('notice from'))
                            return false; // Relay notices/errors
                        if (lowerLine.includes('bad req:'))
                            return false;
                        if (lowerLine.includes('discovery skipping muted user'))
                            return false; // meaningless ids
                        if (lowerLine.includes('timeline lore processing deferred'))
                            return false;
                        if (lowerLine.includes('llm generation attempt') && lowerLine.includes('failed'))
                            return false; // unless critical
                        if (lowerLine.includes('all llm generation retries failed'))
                            return false; // redundant
                        if (lowerLine.includes('round') && lowerLine.includes('metrics:'))
                            return false; // unless quality > 0
                        if (lowerLine.includes('adaptive threshold activated'))
                            return false;
                        if (lowerLine.includes('continuing to round'))
                            return false;
                        if (lowerLine.includes('discovery round'))
                            return false;
                        if (lowerLine.includes('round topics (fallback):'))
                            return false;
                        if (lowerLine.includes('expanded search params:'))
                            return false;
                        if (lowerLine.includes('discovery "') && lowerLine.includes('": relevant'))
                            return false; // generic discovery stats
                        if (lowerLine.includes('generating text with'))
                            return false; // LLM setup noise
                        if (/\b[0-9a-f]{8}\b/.test(line))
                            return false; // filter lines with meaningless hex ids
                        // Filter out large JSON objects (usually context or stats)
                        if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
                            if (line.length > 500)
                                return false;
                        }
                        // Filter out empty lines
                        if (!line.trim())
                            return false;
                        return true;
                    });
                    const result = filteredLines.slice(-lines).join('\n');
                    await logAudit({ type: 'logs_read', lines, filtered: true });
                    return result || "No relevant logs found after filtering.";
                }
                return "Log file not found";
            }
            catch (error) {
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
                if (!fs.existsSync(DB_PATH))
                    return "Database not found";
                // @ts-ignore
                const { Database } = await import('bun:sqlite');
                db = new Database(DB_PATH);
                const result = db.query('SELECT SUM(sats) as total FROM pixels').get();
                const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get();
                const data = { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
                await logAudit({ type: 'treasury_check', ...data });
                return data;
            }
            catch (error) {
                await logAudit({ type: 'treasury_error', error: error.message });
                return { error: `SQLite error: ${error.message}` };
            }
            finally {
                if (db)
                    db.close();
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
                let whereClause;
                if (category === 'messages') {
                    // Messages don't have content.type set, filter by source if provided
                    whereClause = source
                        ? `content->>'type' IS NULL AND content->>'source' = '${source}'`
                        : `content->>'type' IS NULL`;
                }
                else if (category === 'reflections') {
                    whereClause = `content->>'type' IN ('self_reflection', 'life_milestone', 'agent_learning')`;
                }
                else {
                    whereClause = '1=1'; // all
                }
                const query = `SELECT id, created_at, content FROM memories WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;
                const script = `
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite('/app/.eliza/.elizadb');
db.query(\`${query}\`).then(r => console.log(JSON.stringify(r.rows))).catch(e => console.error('ERROR:', e.message));
`;
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 15000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const results = JSON.parse(stdout.trim());
                // Format results based on category
                const memories = results.map((row) => {
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
                    }
                    else {
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
            }
            catch (error) {
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
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 15000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const stats = JSON.parse(stdout.trim());
                await logAudit({ type: 'pixel_stats', ...stats });
                return stats;
            }
            catch (error) {
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
            }
            catch (error) {
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
                }
                catch (buildError) {
                    // 6. Rollback
                    console.error(`[SYNTROPY] Mutation build failed: ${buildError.message}. Rolling back...`);
                    if (oldContent) {
                        await fs.writeFile(filePath, oldContent);
                    }
                    await logAudit({ type: 'mutation_rollback', file, error: buildError.message });
                    return { error: `Mutation failed validation. Reverted to previous stable version. Error: ${buildError.message}` };
                }
            }
            catch (error) {
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
            }
            catch (error) {
                await logAudit({ type: 'report_error', title, error: error.message });
                return { error: error.message };
            }
        }
    }),
    // NOTE: delegateToOpencode has been replaced by spawnWorker (worker-tools.ts)
    // The worker architecture prevents accidental self-destruction by running
    // Opencode in ephemeral containers with guardrails.
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
            }
            catch (e) {
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
                    }
                    catch (e) {
                        return { parse_error: line.substring(0, 100) + '...' };
                    }
                });
                await logAudit({ type: 'audit_read', entries_requested: lines, entries_returned: recentEntries.length });
                return recentEntries;
            }
            catch (error) {
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
Tasks are designed to be atomic and safe - each has rollback instructions if needed.

NOTE: Refactoring tasks are executed by spawning a worker container. Use checkWorkerStatus
to monitor progress after execution starts.`,
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
                    const tasks = [];
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
                    const taskSection = content.slice(content.indexOf(`### ${nextTask.id}:`), content.indexOf(`### T${String(parseInt(nextTask.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length);
                    const dependsMatch = taskSection.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
                    let blockedBy = [];
                    if (dependsMatch) {
                        const deps = dependsMatch[1].match(/T\d{3}/g) || [];
                        const doneTasks = done.map(t => t.id);
                        blockedBy = deps.filter(d => !doneTasks.includes(d));
                    }
                    if (blockedBy.length > 0) {
                        // Find next unblocked task
                        for (const task of readyTasks.slice(1)) {
                            const section = content.slice(content.indexOf(`### ${task.id}:`), content.indexOf(`### T${String(parseInt(task.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length);
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
                    const taskEnd = nextTaskMatch ? taskStart + 10 + nextTaskMatch.index : content.length;
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
                    let updatedContent = content.replace(`### ${taskId}: ${headerMatch[1]} ${headerMatch[2]}`, `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`);
                    await fs.writeFile(QUEUE_PATH, updatedContent);
                    await logAudit({ type: 'refactor_task_start', taskId, title: headerMatch[1] });
                    // Delegate to Worker (using the worker architecture for safety)
                    console.log(`[SYNTROPY] Delegating refactor task ${taskId} to Worker...`);
                    const workerTask = `REFACTORING TASK ${taskId}: ${headerMatch[1]}

${instructions}

After completing the task:
1. Run the verification command if provided
2. Update REFACTOR_QUEUE.md to mark the task as ✅ DONE or ❌ FAILED
3. Update the "Last Processed" timestamp

VERIFICATION COMMAND:
${verifyCommand || 'No verification specified - manually confirm changes work'}

IMPORTANT: After you finish, update /pixel/REFACTOR_QUEUE.md:
- Change "🟡 IN_PROGRESS" to "✅ DONE" (if successful) or "❌ FAILED" (if failed)
- Update "**Last Processed**:" with current timestamp and task ID`;
                    // Use the worker tools directly
                    const { spawnWorkerInternal } = await import('./worker-tools');
                    const workerResult = await spawnWorkerInternal({
                        task: workerTask,
                        context: `Refactoring task from REFACTOR_QUEUE.md. Task ID: ${taskId}`,
                        priority: 'normal'
                    });
                    if ('error' in workerResult) {
                        // Worker spawn failed - revert to READY status
                        const revertContent = await fs.readFile(QUEUE_PATH, 'utf-8');
                        const revertedContent = revertContent.replace(`### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`, `### ${taskId}: ${headerMatch[1]} ⬜ READY`);
                        await fs.writeFile(QUEUE_PATH, revertedContent);
                        return {
                            error: `Failed to spawn worker: ${workerResult.error}`,
                            taskId,
                            status: 'Reverted to READY'
                        };
                    }
                    // Worker spawned successfully - it will update the queue when done
                    return {
                        taskId,
                        status: '🟡 IN_PROGRESS',
                        workerTaskId: workerResult.taskId,
                        message: `Worker spawned for ${taskId}. Use checkWorkerStatus("${workerResult.taskId}") to monitor progress. Worker will update REFACTOR_QUEUE.md when complete.`
                    };
                }
                return { error: 'Invalid action' };
            }
            catch (error) {
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
                let insertPosition;
                if (content.includes(phaseHeader)) {
                    // Find the end of this phase section (before next ## or end of file)
                    const phaseStart = content.indexOf(phaseHeader);
                    const nextSection = content.slice(phaseStart + phaseHeader.length).search(/\n## /);
                    insertPosition = nextSection === -1
                        ? content.length
                        : phaseStart + phaseHeader.length + nextSection;
                }
                else {
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
                let newContent;
                if (!content.includes(phaseHeader)) {
                    // Add new phase section
                    const newPhase = `\n${phaseHeader}\n${newTask}`;
                    newContent = content.slice(0, insertPosition) + newPhase + content.slice(insertPosition);
                }
                else {
                    newContent = content.slice(0, insertPosition) + newTask + content.slice(insertPosition);
                }
                // Update the READY count in the status table
                const readyCount = (newContent.match(/⬜ READY/g) || []).length;
                newContent = newContent.replace(/\| ⬜ READY \| \d+ \|/, `| ⬜ READY | ${readyCount} |`);
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
            }
            catch (error) {
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
                const suggestions = [];
                // Define target paths
                const targetPaths = {
                    'plugin-nostr': path.resolve(PIXEL_ROOT, 'pixel-agent/plugin-nostr/lib'),
                    'syntropy-core': path.resolve(PIXEL_ROOT, 'syntropy-core/src'),
                    'lnpixels-api': path.resolve(PIXEL_ROOT, 'lnpixels/api/src'),
                    'all': PIXEL_ROOT
                };
                const scanPath = targetPaths[target];
                // File size analysis
                if (focusArea === 'file-size' || focusArea === 'all') {
                    try {
                        const { stdout } = await execAsync(`find ${scanPath} -name "*.js" -o -name "*.ts" | xargs wc -l 2>/dev/null | sort -rn | head -10`, { timeout: 30000 });
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
                    }
                    catch (e) {
                        // File analysis failed, continue
                    }
                }
                // Test coverage analysis
                if (focusArea === 'test-coverage' || focusArea === 'all') {
                    try {
                        // Find source files without corresponding test files
                        const { stdout: srcFiles } = await execAsync(`find ${scanPath} -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v test | grep -v ".test." | head -20`, { timeout: 15000 });
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
                    }
                    catch (e) {
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
            }
            catch (error) {
                return { error: error.message };
            }
        }
    }),
    readDiary: tool({
        description: 'Read diary entries from Pixel agent. Use this to access reflections, notes, and evolutionary insights.',
        inputSchema: z.object({
            limit: z.number().optional().describe('Maximum number of entries to return (default: 10)'),
            author: z.string().optional().describe('Filter by author (e.g., "Pixel", "Syntropy")'),
            since: z.string().optional().describe('ISO date string to filter entries created after (e.g., "2025-01-01T00:00:00Z")')
        }),
        execute: async ({ limit, author, since }) => {
            console.log(`[SYNTROPY] Tool: readDiary (limit=${limit || 10}, author=${author || 'any'}, since=${since || 'any'})`);
            try {
                const query = 'SELECT * FROM diary_entries';
                const conditions = [];
                const values = [];
                if (author) {
                    conditions.push(`author = $${values.length + 1}`);
                    values.push(author);
                }
                if (since) {
                    conditions.push(`created_at >= $${values.length + 1}`);
                    values.push(since);
                }
                const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
                const limitClause = limit ? ` LIMIT ${limit}` : '';
                const orderBy = ' ORDER BY created_at DESC';
                const fullQuery = `${query}${whereClause}${orderBy}${limitClause}`;
                const script = `
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite('/app/.eliza/.elizadb');
db.query(\`${fullQuery.replace(/'/g, "\\'").replace(/\$/g, '\\$')}\`, ${JSON.stringify(values)})
  .then(r => console.log(JSON.stringify(r.rows)))
  .catch(e => console.error('ERROR:', e.message));
        `;
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 15000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const entries = JSON.parse(stdout.trim());
                await logAudit({
                    type: 'diary_read',
                    author,
                    count: entries.length,
                    limit
                });
                return {
                    entries,
                    count: entries.length,
                    filters: { author, since, limit }
                };
            }
            catch (error) {
                await logAudit({ type: 'diary_read_error', error: error.message });
                return { error: `Failed to read diary: ${error.message}` };
            }
        }
    }),
    writeDiary: tool({
        description: 'Write a new diary entry. Use this to record insights, learnings, or evolutionary steps.',
        inputSchema: z.object({
            author: z.string().describe('Author name (e.g., "Syntropy", "Pixel")'),
            content: z.string().describe('Diary entry content'),
            tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g., ["learning", "insight"])')
        }),
        execute: async ({ author, content, tags = [] }) => {
            console.log(`[SYNTROPY] Tool: writeDiary (author=${author}, tags=${tags.join(',')})`);
            try {
                const script = `
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite('/app/.eliza/.elizadb');
const id = crypto.randomUUID();
const now = new Date().toISOString();
db.query(
  \`INSERT INTO diary_entries (id, author, content, tags, created_at, updated_at) VALUES ('\${id}', '\${author}', '\${content}', '\${JSON.stringify(tags)}'::text[], '\${now}', '\${now}')\`
)
  .then(() => console.log(JSON.stringify({ id, success: true })))
  .catch(e => console.error('ERROR:', e.message));
        `;
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 15000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const result = JSON.parse(stdout.trim());
                await logAudit({
                    type: 'diary_write',
                    author,
                    tags,
                    entryId: result.id,
                    success: true
                });
                return {
                    success: true,
                    id: result.id,
                    author,
                    content,
                    tags
                };
            }
            catch (error) {
                await logAudit({ type: 'diary_write_error', error: error.message });
                return { error: `Failed to write diary: ${error.message}` };
            }
        }
    }),
    // Worker Architecture Tools (Brain/Hands pattern)
    ...workerTools
};

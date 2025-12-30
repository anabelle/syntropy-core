import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT, PIXEL_AGENT_DIR, CHARACTER_DIR, DB_PATH, LOG_PATH, OPENCODE_LIVE_LOG } from './config';
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
                const { spawn } = require('child_process');
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
                    const escapedBriefing = briefing.replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/`/g, '\\`');
                    const cmd = `opencode run ${fileFlags} "${escapedBriefing}" < /dev/null`;
                    const child = spawn(cmd, [], {
                        env: { ...process.env, CI: 'true', OPENCODE_TELEMETRY_DISABLED: 'true' },
                        shell: true,
                        cwd: PIXEL_ROOT
                    });
                    let fullOutput = '';
                    child.stdout.on('data', (data) => {
                        const str = data.toString();
                        fullOutput += str;
                        logStream.write(str);
                    });
                    child.stderr.on('data', (data) => {
                        const str = data.toString();
                        logStream.write(`[STDERR] ${str}`);
                    });
                    child.on('close', async (code) => {
                        logStream.write(`\n--- DELEGATION END: ${new Date().toISOString()} (Exit Code: ${code}) ---\n`);
                        logStream.end();
                        if (code === 0) {
                            console.log('[SYNTROPY] Opencode task completed');
                            // Try to filter JSON lines if mixed content
                            let summary = fullOutput.trim();
                            const lines = summary.split('\n');
                            const filteredLines = lines.filter((l) => !l.startsWith('{') && !l.startsWith('['));
                            if (filteredLines.length > 0) {
                                summary = filteredLines.join('\n');
                            }
                            await syncAll(); // Sync code changes
                            await logAudit({ type: 'opencode_delegation_success', task, summary: summary.slice(0, 2000) });
                            resolve({ success: true, summary: summary.slice(0, 5000) || "Task completed successfully." });
                        }
                        else {
                            const errorMsg = `Opencode exited with code ${code}`;
                            console.error(`[SYNTROPY] Opencode delegation failed: ${errorMsg}`);
                            await logAudit({ type: 'opencode_delegation_error', error: errorMsg });
                            resolve({ error: `Delegation failed: ${errorMsg}` });
                        }
                    });
                    child.on('error', (err) => {
                        logStream.write(`[PROCESS ERROR] ${err.message}\n`);
                        logStream.end();
                        reject(err);
                    });
                });
            }
            catch (error) {
                console.error(`[SYNTROPY] Opencode delegation failed: ${error.message}`);
                await logAudit({ type: 'opencode_delegation_error', error: error.message });
                return { error: `Delegation failed: ${error.message}` };
            }
        }
    })
};

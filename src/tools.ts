import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  DB_PATH,
  LOG_PATH,
  AUDIT_LOG_PATH
} from './config';
import { logAudit, syncAll } from './utils';
import { workerTools } from './worker-tools';

const execAsync = promisify(exec);
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
const CONTINUITY_PATH = isDocker
  ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
  : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');
import { continuityTools } from './tools/continuity';
import { ecosystemTools } from './tools/ecosystem';
import { nostrTools } from './tools/nostr';
import { memoryTools } from './tools/memory';
import { characterTools } from './tools/character';
import { utilityTools } from './tools/utility';

export const tools = {
  ...continuityTools,
  ...ecosystemTools,
  ...nostrTools,
  ...memoryTools,
  ...characterTools,
  ...utilityTools,

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

          // Delegate to Worker (using the worker architecture for safety)
          console.log(`[SYNTROPY] Delegating refactor task ${taskId} to Worker...`);

          const workerTask = `REFACTORING TASK ${taskId}: ${headerMatch[1]}

${instructions}

After completing the task:
0. Analyze possible side effects and ensure no regressions
0.1 Run existing tests to confirm nothing is broken
0.2 Review code quality and maintainability improvements
0.3 Update all related documentation if applicable
1. Run the verification command if provided
2. Update REFACTOR_QUEUE.md to mark the task as ✅ DONE or ❌ FAILED
3. Update the "Last Processed" timestamp

4. Commit ALL changes (Code + Queue):
   git config --global user.email "bot@syntropy.io"
   git config --global user.name "Syntropy Bot"
   git config --global --add safe.directory /pixel
   git add .
   git commit -m "refactor(${taskId}): ${headerMatch[1]}"

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
            const revertedContent = revertContent.replace(
              `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`,
              `### ${taskId}: ${headerMatch[1]} ⬜ READY`
            );
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
  }),

  readDiary: tool({
    description: 'Read diary entries from the Pixel agent database. Use this to access reflections, notes, and evolutionary insights.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Maximum number of entries to return (default: 10)'),
      author: z.string().optional().describe('Filter by author (e.g., "Pixel", "Syntropy")'),
      since: z.string().optional().describe('ISO date string to filter entries created after (e.g., "2025-01-01T00:00:00Z")')
    }),
    execute: async ({ limit = 10, author, since }) => {
      console.log(`[SYNTROPY] Tool: readDiary (limit=${limit}, author=${author || 'any'}, since=${since || 'any'})`);
      try {
        const conditions: string[] = [];
        if (author) conditions.push(`author = '${author.replace(/'/g, "''")}'`);
        if (since) conditions.push(`created_at >= '${since}'`);

        const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        const limitClause = ` LIMIT ${limit}`;
        const query = `SELECT id, author, content, tags, created_at, updated_at FROM diary_entries${whereClause} ORDER BY created_at DESC${limitClause}`;

        // Format as JSON using PostgreSQL
        const jsonQuery = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query}) t`;

        const { stdout, stderr } = await execAsync(
          `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -A -t -c "${jsonQuery.replace(/"/g, '\\"')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.toLowerCase().includes('error')) {
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
      } catch (error: any) {
        await logAudit({ type: 'diary_read_error', error: error.message });
        return { error: `Failed to read diary: ${error.message}` };
      }
    }
  }),

  writeDiary: tool({
    description: 'Write a new diary entry to the persistent repository. IMPORTANT: You MUST first call readDiary to get context from recent entries before writing. This prevents repetitive entries. Use this to record high-value insights, evolutionary milestones, or narrative shifts.',
    inputSchema: z.object({
      author: z.string().describe('Author name (e.g., "Syntropy", "Pixel")'),
      content: z.string().describe('Diary entry content - must be unique and not repeat themes from recent entries'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g., ["learning", "insight", "crisis-resolved"])'),
      recentContextRead: z.boolean().describe('Confirm you have read recent diary entries via readDiary before writing. Set to true only after calling readDiary first.')
    }),
    execute: async ({ author, content, tags = [], recentContextRead }) => {
      console.log(`[SYNTROPY] Tool: writeDiary (author=${author}, tags=${tags.join(',')}, contextRead=${recentContextRead})`);

      // Enforce context reading requirement
      if (!recentContextRead) {
        return {
          error: 'CONTEXT_REQUIRED: You must first call readDiary to read recent entries before writing a new diary entry. This prevents repetitive entries. After reading, call writeDiary again with recentContextRead=true.',
          hint: 'Call readDiary with limit=5 to see recent entries, then write something that adds NEW value based on that context.'
        };
      }

      try {
        const id = crypto.randomUUID();
        const now = new Date();
        const escapedContent = content.replace(/'/g, "''");
        const tagsArray = tags.length > 0
          ? `ARRAY[${tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]`
          : "'{}'::text[]";

        const query = `INSERT INTO diary_entries (id, author, content, tags, created_at, updated_at) VALUES ('${id}', '${author.replace(/'/g, "''")}', '${escapedContent}', ${tagsArray}, NOW(), NOW())`;

        const { stderr } = await execAsync(
          `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -c "${query.replace(/"/g, '\\"')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.toLowerCase().includes('error')) {
          return { error: stderr };
        }

        // Sync to markdown for knowledge vectorization
        const diaryMdDir = path.resolve(PIXEL_ROOT, 'pixel-agent/docs/v1/diary');
        await fs.ensureDir(diaryMdDir);

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const year = now.getFullYear();
        const month = months[now.getMonth()];
        const day = now.getDate().toString().padStart(2, '0');
        const filename = `${year}-${month}-${day}.md`;
        const filePath = path.join(diaryMdDir, filename);

        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const tagsStr = tags.length > 0 ? `\n**Tags:** ${tags.join(', ')}` : '';

        const entryMarkdown = `
---

### ${timeStr} - ${author}${tagsStr}

${content}

*Entry ID: ${id}*
`;

        if (fs.existsSync(filePath)) {
          await fs.appendFile(filePath, entryMarkdown);
        } else {
          const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
          const dateStr = now.toLocaleDateString('en-US', options);
          const header = `# Pixel's Diary: ${dateStr}\n\n*Auto-synced diary entries from the database. These entries are vectorized for knowledge context.*\n\n`;
          await fs.writeFile(filePath, header + entryMarkdown);
        }

        console.log(`[SYNTROPY] Diary entry synced to ${filename}`);

        await logAudit({
          type: 'diary_write',
          author,
          tags,
          entryId: id,
          mdFile: filename,
          success: true
        });

        return {
          success: true,
          id,
          author,
          tags,
          mdFile: filename,
          message: 'Diary entry persisted to PostgreSQL and synced to markdown for knowledge vectorization'
        };
      } catch (error: any) {
        await logAudit({ type: 'diary_write_error', error: error.message });
        return { error: `Failed to write diary: ${error.message}` };
      }
    }
  }),

  // ============================================
  // WEB ACCESS - Direct synchronous lookups
  // ============================================

  webSearch: tool({
    description: `Search the web and get results IMMEDIATELY (synchronous, same cycle).

Use this for quick lookups during a cycle:
- Get current Bitcoin/crypto prices
- Check latest news headlines
- Look up documentation
- Verify facts before posting
- Get real-time data for announcements

This spawns a quick worker and WAITS for results (max 2 minutes).
For deep research needing multiple sources, use spawnResearchWorker instead.

EXAMPLES:
- "current bitcoin price USD" → Returns live price
- "latest nostr news" → Returns recent headlines
- "ElizaOS documentation memory" → Returns relevant docs`,

    inputSchema: z.object({
      query: z.string().describe('What to search for. Be specific.'),
      maxWaitSeconds: z.number().default(90).describe('Max seconds to wait for results (default: 90)')
    }),

    execute: async ({ query, maxWaitSeconds }) => {
      console.log(`[SYNTROPY] Tool: webSearch (query="${query.slice(0, 50)}...")`);

      const { execAsync } = await import('child_process').then(m => ({ execAsync: m.exec.__promisify__ || require('util').promisify(m.exec) }));

      try {
        // Run opencode directly for quick synchronous search
        const timeout = Math.min(maxWaitSeconds, 120) * 1000; // Cap at 2 minutes

        const { stdout, stderr } = await execAsync(
          `docker run --rm -e CI=true -e OPENROUTER_API_KEY="\${OPENROUTER_API_KEY}" ` +
          `-v ${PIXEL_ROOT}:/pixel -w /pixel --entrypoint opencode pixel-worker:latest ` +
          `run "Search for: ${query.replace(/"/g, '\\"')}. Return a concise summary of what you find. Be brief and factual." ` +
          `-m opencode/gpt-5-nano 2>&1`,
          {
            timeout,
            maxBuffer: 1024 * 1024, // 1MB buffer
            env: { ...process.env }
          }
        );

        // Extract the useful part of the output (after the tool calls)
        const lines = stdout.split('\n');
        const resultLines = lines.filter(line =>
          !line.includes('|  Search') &&
          !line.includes('|  webfetch') &&
          !line.includes('Exit code:') &&
          line.trim().length > 0
        );

        const result = resultLines.join('\n').trim();

        await logAudit({ type: 'web_search', query, success: true });

        return {
          query,
          result: result.slice(-3000), // Last 3KB (the summary is at the end)
          source: 'live_web_search'
        };
      } catch (error: any) {
        await logAudit({ type: 'web_search_error', query, error: error.message });

        if (error.killed || error.message.includes('timeout')) {
          return {
            error: `Search timed out after ${maxWaitSeconds}s. Try a simpler query or use spawnResearchWorker for async.`,
            query
          };
        }

        return { error: error.message, query };
      }
    }
  }),

  // ============================================
  // RESEARCH WORKER - Web Search & Knowledge Gathering
  // ============================================

  spawnResearchWorker: tool({
    description: `Spawn an autonomous worker with FULL CAPABILITIES in an isolated container.

This is a FULL Opencode agent container. It can do ANYTHING you can imagine:

🌐 WEB ACCESS:
- Web Search (Google, Bing, etc.)
- Fetch any URL (APIs, docs, webpages)
- Real-time data (prices, weather, news)
- Scrape and parse structured data

💻 CODE EXECUTION:
- Run bash commands
- Execute scripts (Python, Node, etc.)
- Run tests and analyze output
- Build and compile code

📝 FILE OPERATIONS:
- Read any file in /pixel
- Write new files
- Edit existing code
- Create documentation

🔧 COMBINED WORKFLOWS:
- "Research X, then write a summary to /pixel/docs/X.md"
- "Find the API docs for Y, then create a wrapper in /pixel/src/"
- "Investigate error Z online, then apply the fix"
- "Search for best practices, analyze our code, suggest improvements"
- "Fetch competitor's public repo, compare to ours, write analysis"

The worker is autonomous - give it a goal and let it figure out the steps.
Results are written to files you specify. Check status with checkWorkerStatus.

Think of this as a junior developer you can delegate complex tasks to.`,

    inputSchema: z.object({
      query: z.string().describe('What to research. Be specific about what you want to learn.'),
      context: z.string().optional().describe('Why you need this research (helps focus the search)'),
      outputFile: z.string().optional().describe('Where to save results (default: /pixel/data/research-{timestamp}.md)'),
      depth: z.enum(['quick', 'thorough']).default('quick').describe('quick=2-3 sources, thorough=5+ sources with deeper analysis')
    }),

    execute: async ({ query, context, outputFile, depth }) => {
      console.log(`[SYNTROPY] Tool: spawnResearchWorker (query="${query.slice(0, 50)}...", depth=${depth})`);

      const { spawnWorkerInternal } = await import('./worker-tools');

      const timestamp = Date.now();
      const defaultOutput = `/pixel/data/research-${timestamp}.md`;
      const targetFile = outputFile || defaultOutput;

      // More flexible task framing - this is a full agent, not just research
      const workerTask = `AUTONOMOUS TASK
================

GOAL: ${query}
${context ? `CONTEXT: ${context}` : ''}

You are a fully capable agent in an isolated container with access to:
- Web search and URL fetching
- Bash/shell commands
- File read/write/edit in /pixel
- Code execution (Python, Node, etc.)
- Full codebase at /pixel

APPROACH:
${depth === 'thorough'
          ? `Take your time. Be thorough. Research from multiple angles.
Check 5+ sources if gathering information. Run tests if coding.
Cross-reference findings. Be comprehensive.`
          : `Be efficient. Get the essentials quickly.
If researching: 2-3 good sources.
If coding: minimal viable solution.
Don't over-engineer.`}

DELIVERABLE:
Write your output to: ${targetFile}

Format your output clearly with:
- What you did
- What you found/built
- Key insights or next steps

You have full autonomy. Figure out the best approach to achieve the goal.`;

      const result = await spawnWorkerInternal({
        task: workerTask,
        context: `Web research task. Use the Search tool to find information, then webfetch to read pages. ${context || ''}`,
        priority: 'normal'
      });

      if ('error' in result) {
        await logAudit({ type: 'research_worker_error', query, error: result.error });
        return { error: result.error };
      }

      // Auto-prune old research files (keep last 20)
      const MAX_RESEARCH_FILES = 20;
      try {
        const dataDir = path.join(PIXEL_ROOT, 'data');
        const files = await fs.readdir(dataDir);
        const researchFiles = files
          .filter(f => f.startsWith('research-') && f.endsWith('.md'))
          .sort()
          .reverse(); // Newest first (timestamp in name)

        if (researchFiles.length > MAX_RESEARCH_FILES) {
          const toDelete = researchFiles.slice(MAX_RESEARCH_FILES);
          for (const file of toDelete) {
            await fs.remove(path.join(dataDir, file));
            console.log(`[SYNTROPY] Pruned old research file: ${file}`);
          }
        }
      } catch (pruneError) {
        // Don't fail on prune errors
        console.log(`[SYNTROPY] Research prune warning: ${pruneError}`);
      }

      await logAudit({ type: 'research_worker_spawned', query, taskId: result.taskId, outputFile: targetFile });

      return {
        success: true,
        taskId: result.taskId,
        outputFile: targetFile,
        message: `Research worker spawned. Query: "${query.slice(0, 50)}...". Check status with checkWorkerStatus("${result.taskId}"). Results will be written to ${targetFile}.`
      };
    }
  }),

  readResearchResults: tool({
    description: `Read completed research results from previous spawnResearchWorker calls.

Lists available research files and can read their contents.
Use this to:
- Check what research has been completed
- Get insights from previous research to inform decisions
- Continue researching based on findings

Call with action='list' to see available research, then action='read' with a filename.`,

    inputSchema: z.object({
      action: z.enum(['list', 'read']).describe("'list' to see available, 'read' to get content"),
      filename: z.string().optional().describe("Filename to read (from list results)")
    }),

    execute: async ({ action, filename }) => {
      console.log(`[SYNTROPY] Tool: readResearchResults (action=${action})`);

      const dataDir = path.join(PIXEL_ROOT, 'data');

      if (action === 'list') {
        try {
          const files = await fs.readdir(dataDir);
          const researchFiles = files
            .filter(f => f.startsWith('research-') && f.endsWith('.md'))
            .sort()
            .reverse(); // Newest first

          if (researchFiles.length === 0) {
            return {
              files: [],
              message: 'No research results found. Use spawnResearchWorker to gather information.'
            };
          }

          return {
            files: researchFiles.slice(0, 10), // Show last 10
            total: researchFiles.length,
            hint: "Call with action='read' and filename to see contents"
          };
        } catch (error: any) {
          return { error: error.message };
        }
      }

      if (action === 'read') {
        if (!filename) {
          return { error: "filename is required for action='read'" };
        }

        const filePath = path.join(dataDir, filename);

        if (!await fs.pathExists(filePath)) {
          return { error: `Research file not found: ${filename}` };
        }

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          await logAudit({ type: 'research_read', filename });

          return {
            filename,
            content: content.slice(0, 8000), // Limit to 8KB
            truncated: content.length > 8000
          };
        } catch (error: any) {
          return { error: error.message };
        }
      }

      return { error: `Unknown action: ${action}` };
    }
  }),

  // ============================================
  // IDEA GARDEN - Brainstorming & Creativity
  // ============================================

  tendIdeaGarden: tool({
    description: `Tend the Idea Garden (IDEAS.md). Use at the END of each cycle to nurture creative ideas.

Actions:
- 'read': View all current seeds with their watering counts
- 'plant': Add a new seed from this cycle's observations (max 1 per cycle)
- 'water': Add a thought to an existing seed (exactly 1 per cycle)
- 'harvest': Move a mature idea (5+ waterings) to CONTINUITY.md pending tasks
- 'compost': Archive a stale or failed idea
- 'research': Spawn a worker to research external sources for a seed

Rules:
- Water ONE existing seed per cycle (if any exist)
- Plant at most ONE new seed per cycle
- Harvest requires 5+ waterings AND clear implementation path
- Research spawns a worker with webfetch capability

The garden enables ideas to mature over multiple cycles before becoming tasks.`,

    inputSchema: z.object({
      action: z.enum(['read', 'plant', 'water', 'harvest', 'compost', 'research']).describe('Action to perform'),
      seedTitle: z.string().optional().describe('Title of the seed (required for water/harvest/compost/research)'),
      content: z.string().optional().describe('For plant: the idea origin. For water: new thought. For harvest: task description. For research: research query.'),
      author: z.enum(['Syntropy', 'Human']).default('Syntropy').describe('Who is tending the garden')
    }),

    execute: async ({ action, seedTitle, content, author }) => {
      console.log(`[SYNTROPY] Tool: tendIdeaGarden (action=${action}, seed=${seedTitle || 'N/A'})`);

      const IDEAS_PATH = isDocker
        ? path.resolve(PIXEL_ROOT, 'IDEAS.md')
        : path.resolve(PIXEL_ROOT, 'syntropy-core/IDEAS.md');

      try {
        // Read or initialize garden
        let garden = '';
        if (await fs.pathExists(IDEAS_PATH)) {
          garden = await fs.readFile(IDEAS_PATH, 'utf-8');
        } else {
          garden = `# 🌱 Idea Garden

> Persistent workspace for incubating ideas.

## 🌱 Seeds (0-2 waterings)

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
`;
        }

        const timestamp = new Date().toISOString().split('T')[0];

        // ============================================
        // READ: List all seeds with watering counts
        // ============================================
        if (action === 'read') {
          const seedPattern = /### (.+)\n[\s\S]*?- \*\*Waterings\*\*: (\d+)/g;
          const seeds: Array<{ title: string; waterings: number; section: string }> = [];

          // Find which section each seed is in
          const sections = ['Seeds', 'Sprouting', 'Ready to Harvest', 'Compost'];
          for (const section of sections) {
            const sectionPattern = new RegExp(`## [🌱🌿🌸🍂] ${section}[^#]*`, 'g');
            const sectionMatch = garden.match(sectionPattern);
            if (sectionMatch) {
              let match;
              const sectionContent = sectionMatch[0];
              const localPattern = /### (.+)\n[\s\S]*?- \*\*Waterings\*\*: (\d+)/g;
              while ((match = localPattern.exec(sectionContent)) !== null) {
                seeds.push({
                  title: match[1].trim(),
                  waterings: parseInt(match[2]),
                  section
                });
              }
            }
          }

          // Check for human edits (lines with [Human] that Syntropy hasn't responded to)
          const humanEdits = garden.match(/- \[[\d-]+ Human\] .+/g) || [];

          await logAudit({ type: 'idea_garden_read', seedCount: seeds.length });
          return {
            seeds,
            total: seeds.length,
            humanEdits: humanEdits.length,
            hint: seeds.length === 0
              ? "Garden is empty. Use action='plant' to add a seed."
              : humanEdits.length > 0
                ? `Found ${humanEdits.length} human contribution(s). Acknowledge and water those seeds.`
                : `Water one seed with action='water'.`
          };
        }

        // ============================================
        // PLANT: Add a new seed
        // ============================================
        if (action === 'plant') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (origin) are required for planting" };
          }

          const newSeed = `
### ${seedTitle}
- **Planted**: ${timestamp} by ${author}
- **Origin**: ${content}
- **Waterings**: 0
- **Log**:
`;

          // Insert after "## 🌱 Seeds" header
          garden = garden.replace(
            /## 🌱 Seeds \(0-2 waterings\)\n/,
            `## 🌱 Seeds (0-2 waterings)\n${newSeed}`
          );

          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_plant', seedTitle, author });

          return { success: true, action: 'planted', seedTitle, message: `Seed "${seedTitle}" planted in the garden.` };
        }

        // ============================================
        // WATER: Add thought to existing seed
        // ============================================
        if (action === 'water') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (new thought) are required for watering" };
          }

          // Find the seed
          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found in garden` };
          }

          let seedContent = seedMatch[1];

          // Increment watering count
          const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
          const currentCount = wateringMatch ? parseInt(wateringMatch[1]) : 0;
          const newCount = currentCount + 1;

          seedContent = seedContent.replace(
            /- \*\*Waterings\*\*: \d+/,
            `- **Waterings**: ${newCount}`
          );

          // Add log entry
          const logEntry = `  - [${timestamp} ${author}] ${content}\n`;
          seedContent = seedContent.replace(
            /- \*\*Log\*\*:\n/,
            `- **Log**:\n${logEntry}`
          );

          // Update garden with new seed content
          garden = garden.replace(seedMatch[0], `### ${seedTitle}\n${seedContent}`);

          // Move to appropriate section based on watering count
          if (newCount >= 5) {
            // Move to Ready to Harvest
            const fullSeed = `### ${seedTitle}\n${seedContent}`;
            garden = garden.replace(fullSeed, '');
            garden = garden.replace(
              /## 🌸 Ready to Harvest \(5\+ waterings\)\n/,
              `## 🌸 Ready to Harvest (5+ waterings)\n\n${fullSeed}`
            );
          } else if (newCount >= 3) {
            // Move to Sprouting
            const fullSeed = `### ${seedTitle}\n${seedContent}`;
            garden = garden.replace(fullSeed, '');
            garden = garden.replace(
              /## 🌿 Sprouting \(3-4 waterings\)\n/,
              `## 🌿 Sprouting (3-4 waterings)\n\n${fullSeed}`
            );
          }

          // Clean up extra newlines
          garden = garden.replace(/\n{3,}/g, '\n\n');

          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_water', seedTitle, newCount, author });

          const statusMsg = newCount >= 5
            ? 'READY TO HARVEST! Consider using harvest action.'
            : newCount >= 3
              ? 'Sprouting! Getting closer to actionable.'
              : `${5 - newCount} more waterings until harvest-ready.`;

          return {
            success: true,
            action: 'watered',
            seedTitle,
            newCount,
            status: statusMsg
          };
        }

        // ============================================
        // HARVEST: Move to CONTINUITY.md pending tasks
        // ============================================
        if (action === 'harvest') {
          if (!seedTitle) {
            return { error: "'seedTitle' is required for harvesting" };
          }

          // Find the seed
          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found` };
          }

          const seedContent = seedMatch[1];
          const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
          const waterings = wateringMatch ? parseInt(wateringMatch[1]) : 0;

          if (waterings < 5) {
            return {
              error: `Seed only has ${waterings} waterings. Need 5+ for harvest.`,
              hint: 'Keep watering until the idea is mature.'
            };
          }

          // Extract the log for task description
          const logMatch = seedContent.match(/- \*\*Log\*\*:\n([\s\S]*)/);
          const logContent = logMatch ? logMatch[1].trim() : '';

          // Create task entry for CONTINUITY.md
          const taskEntry = `
### ${seedTitle} (from Idea Garden)
- **Origin**: Harvested from Idea Garden (${waterings} waterings)
- **Summary**: ${content || 'See implementation notes below'}
- **Implementation Notes**:
${logContent.split('\n').map((l: string) => `  ${l}`).join('\n')}
`;

          // Move seed to compost (archived)
          const fullSeed = `### ${seedTitle}\n${seedContent}`;
          garden = garden.replace(fullSeed, '');
          garden = garden.replace(
            /## 🍂 Compost\n/,
            `## 🍂 Compost\n\n${fullSeed.replace(/- \*\*Waterings\*\*: \d+/, '- **Waterings**: HARVESTED')}`
          );

          // Mulch: Keep only 5 most recent compost items (decomposition)
          const compostMatchH = garden.match(/## 🍂 Compost([\s\S]*)/);
          if (compostMatchH) {
            const content = compostMatchH[1];
            const headers = [...content.matchAll(/\n### /g)];
            if (headers.length > 5 && headers[5].index !== undefined) {
              garden = garden.replace(content, content.slice(0, headers[5].index));
            }
          }

          await fs.writeFile(IDEAS_PATH, garden);

          // Append to CONTINUITY.md pending tasks
          let continuity = await fs.readFile(CONTINUITY_PATH, 'utf-8');
          continuity = continuity.replace(
            /## 📬 Pending Tasks\n\n/,
            `## 📬 Pending Tasks\n\n${taskEntry}\n`
          );
          await fs.writeFile(CONTINUITY_PATH, continuity);

          await logAudit({ type: 'idea_garden_harvest', seedTitle, waterings });

          return {
            success: true,
            action: 'harvested',
            seedTitle,
            message: `"${seedTitle}" harvested and added to CONTINUITY.md pending tasks!`
          };
        }

        // ============================================
        // COMPOST: Archive a failed/stale idea
        // ============================================
        if (action === 'compost') {
          if (!seedTitle) {
            return { error: "'seedTitle' is required for composting" };
          }

          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found` };
          }

          const fullSeed = seedMatch[0];
          garden = garden.replace(fullSeed, '');

          // Add reason to the seed
          const compostNote = content ? `  - [${timestamp} ${author}] COMPOSTED: ${content}\n` : '';
          const updatedSeed = fullSeed.replace(
            /- \*\*Log\*\*:\n/,
            `- **Log**:\n${compostNote}`
          );

          garden = garden.replace(
            /## 🍂 Compost\n/,
            `## 🍂 Compost\n\n${updatedSeed}`
          );

          // Mulch: Keep only 5 most recent compost items (decomposition)
          const compostMatchC = garden.match(/## 🍂 Compost([\s\S]*)/);
          if (compostMatchC) {
            const content = compostMatchC[1];
            const headers = [...content.matchAll(/\n### /g)];
            if (headers.length > 5 && headers[5].index !== undefined) {
              garden = garden.replace(content, content.slice(0, headers[5].index));
            }
          }

          garden = garden.replace(/\n{3,}/g, '\n\n');
          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_compost', seedTitle, reason: content });

          return {
            success: true,
            action: 'composted',
            seedTitle,
            message: `"${seedTitle}" moved to compost. Learning preserved.`
          };
        }

        // ============================================
        // RESEARCH: Spawn worker to research external sources
        // ============================================
        if (action === 'research') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (research query) are required" };
          }

          // Import spawnWorkerInternal
          const { spawnWorkerInternal } = await import('./worker-tools');

          const researchTask = `RESEARCH TASK for Idea Garden seed: "${seedTitle}"

Research the topic: ${content}

Use the webfetch tool to:
1. Find 2-3 relevant articles, GitHub repos, or documentation
2. Summarize key insights from each source
3. Suggest implementation approaches based on findings

Write your findings as a summary at the end.

FORMAT YOUR RESPONSE:
## Research: ${seedTitle}
### Sources Found
- [Source 1 title](url): Key insight
- [Source 2 title](url): Key insight

### Key Findings
1. ...
2. ...

### Recommendations for Implementation
1. ...
`;

          const result = await spawnWorkerInternal({
            task: researchTask,
            context: `Research for Idea Garden seed. Use webfetch tool to access external URLs and gather information.`,
            priority: 'normal'
          });

          if ('error' in result) {
            return { error: result.error };
          }

          await logAudit({ type: 'idea_garden_research', seedTitle, taskId: result.taskId });

          return {
            success: true,
            action: 'research_spawned',
            seedTitle,
            taskId: result.taskId,
            message: `Research worker spawned for "${seedTitle}". Check status with checkWorkerStatus("${result.taskId}"). Results will inform next watering.`
          };
        }

        return { error: `Unknown action: ${action}` };

      } catch (error: any) {
        await logAudit({ type: 'idea_garden_error', action, error: error.message });
        return { error: `Idea Garden error: ${error.message}` };
      }
    }
  }),

  // Worker Architecture Tools (Brain/Hands pattern)
  ...workerTools
};

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
import { refactoringTools } from './tools/refactoring';
import { diaryTools } from './tools/diary';

export const tools = {
  ...continuityTools,
  ...ecosystemTools,
  ...nostrTools,
  ...memoryTools,
  ...characterTools,
  ...utilityTools,
  ...refactoringTools,
  ...diaryTools,

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

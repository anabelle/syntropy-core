import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT
} from '../config';
import { logAudit } from '../utils';

const execAsync = promisify(exec);

export const researchTools = {
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
        const timeout = Math.min(maxWaitSeconds, 120) * 1000;

        const { stdout, stderr } = await execAsync(
          `docker run --rm -e CI=true -e OPENROUTER_API_KEY="\${OPENROUTER_API_KEY}" ` +
          `-v ${PIXEL_ROOT}:/pixel -w /pixel --entrypoint opencode pixel-worker:latest ` +
          `run "Search for: ${query.replace(/"/g, '\\"')}. Return a concise summary of what you find. Be brief and factual." ` +
          `-m opencode/gpt-5-nano 2>&1`,
          {
            timeout,
            maxBuffer: 1024 * 1024,
            env: { ...process.env }
          }
        );

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
          result: result.slice(-3000),
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

      const { spawnWorkerInternal } = await import('../worker-tools');

      const timestamp = Date.now();
      const defaultOutput = `/pixel/data/research-${timestamp}.md`;
      const targetFile = outputFile || defaultOutput;

      const workerTask = `AUTONOMOUS TASK
===============

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

      const MAX_RESEARCH_FILES = 20;
      try {
        const dataDir = path.join(PIXEL_ROOT, 'data');
        const files = await fs.readdir(dataDir);
        const researchFiles = files
          .filter(f => f.startsWith('research-') && f.endsWith('.md'))
          .sort()
          .reverse();

        if (researchFiles.length > MAX_RESEARCH_FILES) {
          const toDelete = researchFiles.slice(MAX_RESEARCH_FILES);
          for (const file of toDelete) {
            await fs.remove(path.join(dataDir, file));
            console.log(`[SYNTROPY] Pruned old research file: ${file}`);
          }
        }
      } catch (pruneError) {
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
            .reverse();

          if (researchFiles.length === 0) {
            return {
              files: [],
              message: 'No research results found. Use spawnResearchWorker to gather information.'
            };
          }

          return {
            files: researchFiles.slice(0, 10),
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
            content: content.slice(0, 8000),
            truncated: content.length > 8000
          };
        } catch (error: any) {
          return { error: error.message };
        }
      }

      return { error: `Unknown action: ${action}` };
    }
  })
};

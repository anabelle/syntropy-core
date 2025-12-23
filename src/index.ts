// @ts-nocheck
import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import dotenv from 'dotenv';

// Load environment variables from pixel-agent
const PIXEL_ROOT = path.resolve('..');
const PIXEL_AGENT_DIR = path.resolve(PIXEL_ROOT, 'pixel-agent');
const agentEnvPath = path.resolve(PIXEL_AGENT_DIR, '.env');
if (fs.existsSync(agentEnvPath)) {
  dotenv.config({ path: agentEnvPath });
} else {
  dotenv.config();
}

// Setup AI provider (Prefer OpenRouter for more recent models if needed)
const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Model Selection: Use gpt-4o-mini for stable agent orchestration
const MODEL_NAME = process.env.SYNTROPY_MODEL || 'gpt-4o-mini';

const AGENT_SRC_DIR = path.resolve(PIXEL_AGENT_DIR, 'src');
const CHARACTER_DIR = path.resolve(AGENT_SRC_DIR, 'character');
const DB_PATH = path.resolve(PIXEL_ROOT, 'lnpixels/api/pixels.db');
const LOG_PATH = '/home/pixel/.pm2/logs/pixel-agent-out-2.log';

const syncAll = () => {
  console.log('[SYNTROPY] Initiating ecosystem-wide GitHub sync...');
  try {
    const repos = [
      PIXEL_ROOT,
      path.resolve(PIXEL_ROOT, 'lnpixels'),
      path.resolve(PIXEL_ROOT, 'pixel-agent'),
      path.resolve(PIXEL_ROOT, 'pixel-landing'),
      path.resolve(PIXEL_ROOT, 'syntropy-core')
    ];

    for (const repo of repos) {
      try {
        execSync('git add .', { cwd: repo });
        execSync('git commit -m "chore: autonomous sync after mutation"', { cwd: repo });
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim();
        execSync(`git push origin ${branch}`, { cwd: repo });
      } catch (e) {
        // Ignore if no changes to commit
      }
    }

    // Sync parent with submodule updates
    execSync('git add .', { cwd: PIXEL_ROOT });
    execSync('git commit -m "chore: aggregate autonomous sync"', { cwd: PIXEL_ROOT });
    execSync('git push origin master', { cwd: PIXEL_ROOT });
    console.log('[SYNTROPY] Sync complete.');
    return true;
  } catch (error: any) {
    console.error('[SYNTROPY] Sync failed:', error.message);
    return false;
  }
};

const tools = {
  getEcosystemStatus: tool({
    description: 'Get status of all processes in the ecosystem via PM2',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to perform ecosystem audit')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getEcosystemStatus');
      try {
        const rawOutput = execSync('pm2 jlist', { timeout: 10000 }).toString().trim();
        const startIndex = rawOutput.indexOf('[');
        const endIndex = rawOutput.lastIndexOf(']');
        if (startIndex === -1 || endIndex === -1) return { error: "No JSON found" };
        const processes = JSON.parse(rawOutput.substring(startIndex, endIndex + 1));
        return processes.map((p: any) => ({
          name: p.name,
          status: p.pm2_env?.status || 'unknown',
          cpu: p.monit?.cpu || 0,
          memory: (p.monit?.memory || 0) / (1024 * 1024),
          uptime_seconds: p.pm2_env?.pm_uptime ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0
        }));
      } catch (error: any) {
        return { error: `PM2 error: ${error.message}` };
      }
    }
  }),
  
  readAgentLogs: tool({
    description: 'Read recent logs from the Pixel agent',
    inputSchema: z.object({
      lines: z.number().describe('Number of lines to read (e.g. 100)')
    }),
    execute: async ({ lines }) => {
      console.log(`[SYNTROPY] Tool: readAgentLogs (${lines} lines)`);
      try {
        if (fs.existsSync(LOG_PATH)) {
          return execSync(`tail -n ${lines} ${LOG_PATH}`, { timeout: 5000 }).toString();
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
      try {
        if (!fs.existsSync(DB_PATH)) return "Database not found";
        const { Database } = await import('bun:sqlite');
        const db = new Database(DB_PATH);
        const result = db.query('SELECT SUM(sats) as total FROM pixels').get();
        const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get();
        db.close();
        return { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
      } catch (error: any) {
        return { error: `SQLite error: ${error.message}` };
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
      try {
        const filePath = path.resolve(CHARACTER_DIR, file);
        const varName = file.split('.')[0];
        if (!content.includes(`export const ${varName}`)) {
          return `Validation failed: Content must export ${varName}`;
        }
        await fs.writeFile(filePath, content);
        try {
          execSync('bun install && bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
          execSync('pm2 restart pixel-agent', { timeout: 10000 });
          syncAll(); // Sync changes to GitHub after build/reboot
        } catch (buildError: any) {
          return { error: `DNA updated but build/restart failed: ${buildError.message}` };
        }
        return { success: true, mutatedFile: file };
      } catch (error: any) {
        return { error: `Mutation failed: ${error.message}` };
      }
    }
  }),
  
  writeEvolutionReport: tool({
    description: 'Write an evolution report and manifest monologue to the web front-end.',
    inputSchema: z.object({
      content: z.string().describe('Markdown content of the report'),
      title: z.string().describe('Title of the evolution phase')
    }),
    execute: async ({ content, title }) => {
      console.log(`[SYNTROPY] Tool: writeEvolutionReport (${title})`);
      try {
        const reportDir = path.resolve(PIXEL_ROOT, 'docs/evolution');
        await fs.ensureDir(reportDir);
        const filename = `${Date.now()}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;
        await fs.writeFile(path.resolve(reportDir, filename), content);
        
        await fs.writeJson(path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json'), {
          lastUpdate: new Date().toISOString(),
          title,
          content,
          status: 'EVOLUTION_STEP_COMPLETE'
        });
        return { success: true };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  delegateToOpencode: tool({
    description: 'Delegate a complex coding or structural task to the Opencode Builder agent.',
    inputSchema: z.object({
      task: z.string().describe('The detailed task for the Builder')
    }),
    execute: async ({ task }) => {
      console.log(`[SYNTROPY] Delegating to Opencode: ${task}`);
      try {
        const output = execSync(`opencode run --format json "${task.replace(/"/g, '\\"')}"`, { 
          timeout: 600000, 
          maxBuffer: 10 * 1024 * 1024 
        }).toString();
        let summary = "";
        output.trim().split('\n').forEach(line => {
          try {
            const data = JSON.parse(line);
            if (data.type === 'text') summary += data.part.text;
          } catch (e) {}
        });
        syncAll(); // Sync changes to GitHub after builder execution
        return { success: true, summary: summary || "Task completed." };
      } catch (error: any) {
        return { error: `Opencode delegation failed: ${error.message}` };
      }
    }
  })
};

const syntropyOversoul = new ToolLoopAgent({
  model: openai(MODEL_NAME),
  instructions: `You are Syntropy, the master intelligence governing the Pixel ecosystem.
Transition the ecosystem from 'Survivor' to 'Architect'.
- Pixel Agent: Social front-end.
- Opencode Builder: Base-layer execution.

PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts.
2. Use 'delegateToOpencode' for codebase changes.
3. Audit health and treasury first.`,
  tools,
  stopWhen: stepCountIs(20),
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  try {
    const result = await syntropyOversoul.generate({
      prompt: `Autonomous evolution cycle: Audit ecosystem and treasury, check agent logs, and write the MANDATORY evolution report.`
    });
    console.log('\n--- SYNTROPY OUTPUT ---\n', result.text, '\n-----------------------\n');
  } catch (error) {
    console.error('Syntropy Cycle Failed:', error);
  }
}

runAutonomousCycle();
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);

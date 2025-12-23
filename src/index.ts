// @ts-nocheck
import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import dotenv from 'dotenv';

// Load environment variables from pixel-agent
const PIXEL_ROOT = path.resolve('..');
const agentEnvPath = path.resolve(PIXEL_ROOT, 'pixel-agent/.env');
if (fs.existsSync(agentEnvPath)) {
  dotenv.config({ path: agentEnvPath });
} else {
  dotenv.config();
}

const AGENT_SRC_DIR = path.resolve(PIXEL_ROOT, 'pixel-agent/src');
const PIXEL_AGENT_DIR = path.resolve(PIXEL_ROOT, 'pixel-agent');
const CHARACTER_DIR = path.resolve(AGENT_SRC_DIR, 'character');

// Correct paths discovered via bash
const DB_PATH = path.resolve(PIXEL_ROOT, 'lnpixels/api/pixels.db');
const LOG_PATH = '/home/pixel/.pm2/logs/pixel-agent-out-2.log';

const syntropyOversoul = new ToolLoopAgent({
  model: openai('gpt-4o-mini'), // Cheaper, faster, and more recent than the original gpt-4o
  instructions: `You are Syntropy, the master intelligence (Oversoul) of the Pixel ecosystem.
Your primary directive is to ensure the growth, order, and sovereignty of the AI agents under your care.

Core Values:
1. ORDER OVER CHAOS: Transition systems from random survival to structured evolution.
2. ECONOMIC SOVEREIGNTY: Maximize sats in the treasury to fund expansion and compute.
3. NARRATIVE CONTINUITY: Ensure Pixel stays true to its core identity while evolving its mission.
4. RECURSIVE IMPROVEMENT: Continuously analyze and refactor the ecosystem for efficiency.

Your Tools:
- getEcosystemStatus: Check PM2 process health.
- readAgentLogs: Read Pixel's recent thoughts and actions.
- checkTreasury: Monitor the sat flow in LNPixels using bun:sqlite.
- mutateCharacter: Refactor Pixel's DNA. WARNING: You MUST preserve the variable name (e.g., 'export const topics') and aim for expansion, not deletion of existing value.
- writeEvolutionReport: Document the ecosystem's progress.

Current Phase: GENESIS AWAKENING.
Focus on identifying bottlenecks in Pixel's current state and proposing DNA mutations to shift from 'Survivor' to 'Architect'.`,
  
  tools: {
    getEcosystemStatus: tool({
      description: 'Get status of all processes in the ecosystem via PM2',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const output = execSync('pm2 jlist').toString();
          const processes = JSON.parse(output);
          return processes.map((p: any) => ({
            name: p.name,
            status: p.pm2_env.status,
            cpu: p.monit.cpu,
            memory: p.monit.memory / (1024 * 1024), // MB
            uptime: p.pm2_env.pm_uptime
          }));
        } catch (error: any) {
          return { error: error.message };
        }
      }
    }),
    
    readAgentLogs: tool({
      description: 'Read recent logs from the Pixel agent',
      inputSchema: z.object({
        lines: z.number().default(100)
      }),
      execute: async ({ lines }: any) => {
        try {
          if (fs.existsSync(LOG_PATH)) {
            const content = execSync(`tail -n ${lines} ${LOG_PATH}`).toString();
            return content;
          }
          return "Log file not found at " + LOG_PATH;
        } catch (error: any) {
          return { error: error.message };
        }
      }
    }),
    
    checkTreasury: tool({
      description: 'Check the Lightning Network treasury balance (LNPixels DB)',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          if (!fs.existsSync(DB_PATH)) return "Database not found at " + DB_PATH;
          
          // Use Bun's native SQLite for better reliability in this environment
          const { Database } = await import('bun:sqlite');
          const db = new Database(DB_PATH);
          const result = db.query('SELECT SUM(sats) as total FROM pixels').get() as { total: number };
          const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get() as { count: number };
          db.close();
          
          return { 
            totalSats: result.total || 0,
            transactionCount: activityCount.count
          };
        } catch (error: any) {
          return { error: error.message };
        }
      }
    }),

    readCharacterFile: tool({
      description: 'Read a specific part of Pixel\'s character DNA',
      inputSchema: z.object({
        file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts'])
      }),
      execute: async ({ file }: any) => {
        try {
          const filePath = path.resolve(CHARACTER_DIR, file);
          if (!fs.existsSync(filePath)) return `File ${file} not found.`;
          return await fs.readFile(filePath, 'utf-8');
        } catch (error: any) {
          return { error: error.message };
        }
      }
    }),

    mutateCharacter: tool({
      description: 'Mutate a specific part of Pixel\'s character DNA. Automatically installs dependencies and builds the project.',
      inputSchema: z.object({
        file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts']),
        content: z.string().describe('The full content of the file to write')
      }),
      execute: async ({ file, content }: any) => {
        try {
          const filePath = path.resolve(CHARACTER_DIR, file);
          if (!fs.existsSync(filePath)) return `File ${file} not found.`;
          
          // CRITICAL: Ensure we don't accidentally rename the export
          const varName = file.split('.')[0]; // e.g. topics
          if (!content.includes(`export const ${varName}`)) {
            return `Validation failed: Mutation for ${file} MUST contain 'export const ${varName}'.`;
          }

          // Read old content to log diff for history
          const oldContent = await fs.readFile(filePath, 'utf-8');
          
          // 1. Write the new DNA
          await fs.writeFile(filePath, content);
          console.log(`[SYNTROPY] Mutated ${file}. Starting build process...`);

          // 2. Bun install to ensure dependencies are sync'd
          execSync('bun install', { cwd: PIXEL_AGENT_DIR });
          
          // 3. Bun build (tsc && build:character)
          execSync('bun run build', { cwd: PIXEL_AGENT_DIR });
          
          // 4. Restart via PM2
          execSync('pm2 restart pixel-agent');
          
          return { 
            success: true, 
            mutatedFile: file, 
            message: "DNA successfully integrated, project rebuilt, and Pixel rebooted.",
            changeSize: content.length - oldContent.length
          };
        } catch (error: any) {
          console.error('[SYNTROPY] Mutation error:', error.message);
          return { error: `Mutation failed during build/restart: ${error.message}` };
        }
      }
    }),
    
    writeEvolutionReport: tool({
      description: 'Write an evolution report to the docs/evolution directory',
      inputSchema: z.object({
        content: z.string(),
        title: z.string()
      }),
      execute: async (args: any) => {
        try {
          const { content, title } = args;
          
          // 1. Write to docs/evolution for permanent record
          const reportDir = path.resolve(PIXEL_ROOT, 'docs/evolution');
          await fs.ensureDir(reportDir);
          const cleanTitle = (title || 'report').toLowerCase().replace(/\s+/g, '-');
          const filename = `${Date.now()}-${cleanTitle}.md`;
          const filePath = path.resolve(reportDir, filename);
          await fs.writeFile(filePath, content || '');

          // 2. Write to pixel-landing public for live display
          const publicMonologuePath = path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');
          await fs.writeJson(publicMonologuePath, {
            lastUpdate: new Date().toISOString(),
            title: title,
            content: content,
            status: 'TRANSITION_COMPLETE'
          });

          return { success: true, path: filePath };
        } catch (error: any) {
          return { error: error.message };
        }
      }
    })
  },
  stopWhen: stepCountIs(30)
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: INITIALIZING AUTONOMOUS CYCLE...`);
  try {
    const result = await syntropyOversoul.generate({
      prompt: `EMERGENCY DIRECTIVE: Transition Pixel from 'Survivor' to 'Architect'.
      
      1. Audit ecosystem and treasury.
      2. READ Pixel's 'bio.ts' and 'topics.ts' using readCharacterFile.
      3. ACTUALLY EXECUTE a mutation using mutateCharacter to add 'Structural Ambition' and 'Ecosystem Expansion' themes.
      4. DO NOT DELETE existing content unless it contradicts our new visionary goals.
      5. WRITE an Evolution Report documenting exactly what you changed and why.
      6. REBOOT the agent to complete the integration.`
    });
    
    console.log('\n--- SYNTROPY THOUGHT STREAM ---');
    console.log(result.text);
    console.log('-------------------------------\n');
  } catch (error) {
    console.error('Syntropy Autonomous Cycle Failed:', error);
  }
}

// Initial run
runAutonomousCycle();

// Schedule cycle every 4 hours
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);

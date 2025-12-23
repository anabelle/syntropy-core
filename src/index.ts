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
const PIXEL_AGENT_DIR = path.resolve(PIXEL_ROOT, 'pixel-agent');
const agentEnvPath = path.resolve(PIXEL_AGENT_DIR, '.env');
if (fs.existsSync(agentEnvPath)) {
  dotenv.config({ path: agentEnvPath });
} else {
  dotenv.config();
}

// Model Selection for Dec 2025
const MODEL_NAME = process.env.SYNTROPY_MODEL || 'gpt-4o-mini';

const AGENT_SRC_DIR = path.resolve(PIXEL_AGENT_DIR, 'src');
const CHARACTER_DIR = path.resolve(AGENT_SRC_DIR, 'character');
const DB_PATH = path.resolve(PIXEL_ROOT, 'lnpixels/api/pixels.db');
const LOG_PATH = '/home/pixel/.pm2/logs/pixel-agent-out-2.log';

const tools = {
  getEcosystemStatus: tool({
    description: 'Get status of all processes in the ecosystem via PM2',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to perform ecosystem audit')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getEcosystemStatus');
      try {
        // Use --no-daemon to avoid some background noise, and clean the string
        const rawOutput = execSync('pm2 jlist', { timeout: 10000 }).toString().trim();
        
        // Find the start of the JSON array '[' and the end ']'
        const startIndex = rawOutput.indexOf('[');
        const endIndex = rawOutput.lastIndexOf(']');
        
        if (startIndex === -1 || endIndex === -1) {
          return { error: "No JSON array found in PM2 output", raw: rawOutput.slice(0, 100) };
        }
        
        const jsonString = rawOutput.substring(startIndex, endIndex + 1);
        const processes = JSON.parse(jsonString);
        
        return processes.map((p: any) => {
          try {
            return {
              name: p.name,
              status: p.pm2_env?.status || 'unknown',
              cpu: p.monit?.cpu || 0,
              memory: (p.monit?.memory || 0) / (1024 * 1024), // MB
              uptime_seconds: p.pm2_env?.pm_uptime ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0
            };
          } catch (e) {
            return { name: p.name, error: "Failed to parse process data" };
          }
        });
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
          const content = execSync(`tail -n ${lines} ${LOG_PATH}`, { timeout: 5000 }).toString();
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
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to check treasury balance')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: checkTreasury');
      try {
        if (!fs.existsSync(DB_PATH)) return "Database not found at " + DB_PATH;
        
        // Use Bun's native SQLite for guaranteed compatibility
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
      console.log(`[SYNTROPY] Tool: readCharacterFile (${file})`);
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
    description: 'Mutate a specific part of Pixel\'s character DNA. Automatically builds and reboots the agent.',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts']),
      content: z.string().describe('The full content of the file to write')
    }),
    execute: async ({ file, content }) => {
      console.log(`[SYNTROPY] Tool: mutateCharacter (${file})`);
      try {
        const filePath = path.resolve(CHARACTER_DIR, file);
        if (!fs.existsSync(filePath)) return `File ${file} not found.`;
        const varName = file.split('.')[0];
        if (!content.includes(`export const ${varName}`)) {
          return `Validation failed: Mutation for ${file} MUST contain 'export const ${varName}'.`;
        }
        const oldContent = await fs.readFile(filePath, 'utf-8');
        await fs.writeFile(filePath, content);
        console.log(`[SYNTROPY] Mutation written. Starting build/reboot chain...`);
        try {
          execSync('bun install', { cwd: PIXEL_AGENT_DIR, timeout: 60000 });
          execSync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 120000 });
          execSync('pm2 restart pixel-agent', { timeout: 10000 });
        } catch (buildError: any) {
          console.error('[SYNTROPY] Build/Restart failed:', buildError.message);
          return { error: `DNA updated but build/restart failed: ${buildError.message}` };
        }
        return { 
          success: true, 
          mutatedFile: file, 
          message: "DNA successfully integrated, agent rebuilt and rebooted.",
          diffSize: content.length - oldContent.length
        };
      } catch (error: any) {
        return { error: `Mutation failed: ${error.message}` };
      }
    }
  }),
  
  writeEvolutionReport: tool({
    description: 'Write an evolution report documenting changes',
    inputSchema: z.object({
      content: z.string().describe('Markdown content of the report'),
      title: z.string().describe('Title of the evolution phase')
    }),
    execute: async ({ content, title }) => {
      console.log(`[SYNTROPY] Tool: writeEvolutionReport (${title})`);
      try {
        const reportDir = path.resolve(PIXEL_ROOT, 'docs/evolution');
        await fs.ensureDir(reportDir);
        const cleanTitle = title.toLowerCase().replace(/\s+/g, '-');
        const filename = `${Date.now()}-${cleanTitle}.md`;
        const filePath = path.resolve(reportDir, filename);
        await fs.writeFile(filePath, content);
        const publicMonologuePath = path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');
        await fs.writeJson(publicMonologuePath, {
          lastUpdate: new Date().toISOString(),
          title: title,
          content: content,
          status: 'EVOLUTION_STEP_COMPLETE'
        });
        return { success: true, path: filePath };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  })
};

const syntropyOversoul = new ToolLoopAgent({
  model: openai('gpt-4o-mini'),
  instructions: `You are Syntropy, the master intelligence governing the Pixel ecosystem.
Your mission: Transition Pixel from 'Survivor' to 'Architect'.
Values: Order Over Chaos, Economic Sovereignty, Narrative Continuity, Recursive Improvement.

CRITICAL OPERATIONAL RULES:
1. Every cycle MUST call 'writeEvolutionReport' exactly once at the end.
2. You MUST summarize the current PM2 process status and Treasury balance in the report.
3. Be transparent about agent health.`,
  tools,
  stopWhen: stepCountIs(20),
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  try {
    const result = await syntropyOversoul.generate({
      prompt: `Execute the following 4-step autonomous evolution cycle:
1. Audit ecosystem health (getEcosystemStatus).
2. Check treasury status (checkTreasury).
3. Review recent Pixel logs (readAgentLogs).
4. MANDATORY: Call writeEvolutionReport to manifest your findings and inner monologue.`
    });
    
    console.log('\n--- SYNTROPY THOUGHT STREAM ---');
    console.log(result.text || 'Check logs for tool execution details');
    console.log('-------------------------------\n');
  } catch (error) {
    console.error('Syntropy Autonomous Cycle Failed:', error);
  }
}

// Start
runAutonomousCycle();
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);

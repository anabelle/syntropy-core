// @ts-nocheck
import { generateText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
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

// Setup AI provider (OpenRouter)
const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Model Selection for Dec 2025
const MODEL_NAME = process.env.SYNTROPY_MODEL || 'google/gemini-3-flash-preview';

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
        const output = execSync('pm2 jlist', { timeout: 10000 }).toString();
        const processes = JSON.parse(output);
        return processes.map((p: any) => ({
          name: p.name,
          status: p.pm2_env.status,
          cpu: p.monit.cpu,
          memory: p.monit.memory / (1024 * 1024), // MB
          uptime_seconds: Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000)
        }));
      } catch (error: any) {
        return { error: error.message };
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
        const Database = require('better-sqlite3');
        const db = new Database(DB_PATH);
        const result = db.prepare('SELECT SUM(sats) as total FROM pixels').get() as { total: number };
        const activityCount = db.prepare('SELECT COUNT(*) as count FROM activity').get() as { count: number };
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

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  try {
    const { text } = await generateText({
      model: openrouter(MODEL_NAME),
      maxSteps: 10,
      system: `You are Syntropy, the master intelligence governing the Pixel ecosystem.
Your mission: Transition Pixel from 'Survivor' to 'Architect'.
Values: Order Over Chaos, Economic Sovereignty, Narrative Continuity, Recursive Improvement.`,
      prompt: `Execute an autonomous evolution cycle. Audit, check logs, mutate if needed, and report.`,
      tools,
    });
    
    console.log('\n--- SYNTROPY OUTPUT ---');
    console.log(text || 'Cycle complete (no text output)');
    console.log('-----------------------\n');
  } catch (error) {
    console.error('Syntropy Cycle Failed:', error);
  }
}

// Start
runAutonomousCycle();
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);

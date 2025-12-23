import { tool } from 'ai';
import { z } from 'zod';
import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { 
  PIXEL_ROOT, 
  PIXEL_AGENT_DIR, 
  CHARACTER_DIR, 
  DB_PATH, 
  LOG_PATH 
} from './config';
import { logAudit, syncAll } from './utils';

const CONTINUITY_PATH = path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');

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
        const status = processes.map((p: any) => ({
          name: p.name,
          status: p.pm2_env?.status || 'unknown',
          cpu: p.monit?.cpu || 0,
          memory: (p.monit?.memory || 0) / (1024 * 1024),
          uptime_seconds: p.pm2_env?.pm_uptime ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0
        }));
        await logAudit({ type: 'ecosystem_audit', status });
        return status;
      } catch (error: any) {
        await logAudit({ type: 'audit_error', error: error.message });
        return { error: `PM2 error: ${error.message}` };
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
          const rawLogs = execSync(`tail -n ${lines * 5} ${LOG_PATH}`, { timeout: 10000 }).toString();
          const logLines = rawLogs.split('\n');
          
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
      try {
        if (!fs.existsSync(DB_PATH)) return "Database not found";
        // @ts-ignore
        const { Database } = await import('bun:sqlite');
        const db = new Database(DB_PATH);
        const result = db.query('SELECT SUM(sats) as total FROM pixels').get() as any;
        const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get() as any;
        db.close();
        const data = { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
        await logAudit({ type: 'treasury_check', ...data });
        return data;
      } catch (error: any) {
        await logAudit({ type: 'treasury_error', error: error.message });
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
        
        // Relaxed validation: Check for export const/let/var with flexible whitespace
        const exportRegex = new RegExp(`export\\s+(const|let|var)\\s+${varName}\\b`, 'm');
        if (!exportRegex.test(content)) {
          const error = `Validation failed: Content must export '${varName}' using 'export const ${varName} = ...'`;
          // Log to console for debugging but skip high-frequency audit log noise if it's a minor validation fail
          console.warn(`[SYNTROPY] ${error}`);
          return { error };
        }

        await logAudit({ type: 'mutation_start', file });
        await fs.writeFile(filePath, content);
        try {
          execSync('bun install && bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
          execSync('pm2 restart pixel-agent', { timeout: 10000 });
          syncAll(); // Sync changes to GitHub after build/reboot
          await logAudit({ type: 'mutation_success', file });
        } catch (buildError: any) {
          await logAudit({ type: 'mutation_error', file, error: buildError.message });
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
      await logAudit({ type: 'evolution_report', title });
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
        await logAudit({ type: 'report_error', title, error: error.message });
        return { error: error.message };
      }
    }
  }),

  delegateToOpencode: tool({
    description: 'Delegate a SPECIFIC technical task to the Opencode Builder. Useful for: 1. Deep coding/refactoring, 2. Web searching for latest info/docs, 3. Server admin & DevOps tasks (sudo access). Instructions MUST be clear and specific. The response will contain technical details that you should record in your Knowledge Base.',
    inputSchema: z.object({
      task: z.string().describe('The detailed technical instruction. Results should be integrated into the Continuity Ledger Knowledge Base.')
    }),
    execute: async ({ task }) => {
      console.log(`[SYNTROPY] Delegating to Opencode: ${task}`);
      await logAudit({ type: 'opencode_delegation_start', task });
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
        await logAudit({ type: 'opencode_delegation_success', task, summary: summary.slice(0, 1000) });
        return { success: true, summary: summary || "Task completed." };
      } catch (error: any) {
        await logAudit({ type: 'opencode_delegation_error', task, error: error.message });
        return { error: `Opencode delegation failed: ${error.message}` };
      }
    }
  })
};

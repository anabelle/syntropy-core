import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  DB_PATH,
  AUDIT_LOG_PATH
} from '../config';
import { logAudit, syncAll } from '../utils';

const execAsync = promisify(exec);

export const utilityTools = {
  gitSync: tool({
    description: `Commit and push changes across all repositories. Use this ONLY when you have made meaningful changes that should be persisted. 
    
WHEN TO USE:
- After updating CONTINUITY.md with significant changes
- After writing evolution reports
- After successful code mutations
- After modifying configuration files

WHEN NOT TO USE:
- After routine read operations
- After failed operations (nothing to commit)
- Multiple times in rapid succession (rate limit: once per 10 minutes)

The reason you provide becomes the commit message - make it descriptive!`,
    inputSchema: z.object({
      reason: z.string().describe('A descriptive commit message explaining what changed and why. This becomes the git commit message.')
    }),
    execute: async ({ reason }) => {
      console.log(`[SYNTROPY] Tool: gitSync - "${reason}"`);

      // Rate limiting - prevent spam commits
      const lastSyncFile = path.join(PIXEL_ROOT, 'data', '.last-sync');
      const now = Date.now();
      const minInterval = 10 * 60 * 1000; // 10 minutes

      try {
        if (fs.existsSync(lastSyncFile)) {
          const lastSync = parseInt(await fs.readFile(lastSyncFile, 'utf-8'), 10);
          if (now - lastSync < minInterval) {
            const waitMins = Math.ceil((minInterval - (now - lastSync)) / 60000);
            return {
              skipped: true,
              message: `Rate limited. Last sync was ${Math.round((now - lastSync) / 60000)} minutes ago. Wait ${waitMins} more minutes.`
            };
          }
        }
      } catch (e) {
        // Ignore read errors
      }

      try {
        await syncAll({ reason });

        // Update last sync timestamp
        await fs.ensureDir(path.dirname(lastSyncFile));
        await fs.writeFile(lastSyncFile, now.toString());

        await logAudit({ type: 'git_sync', reason });
        return { success: true, message: `Synced with commit: "${reason}"` };
      } catch (error: any) {
        await logAudit({ type: 'git_sync_error', reason, error: error.message });
        return { error: `Sync failed: ${error.message}` };
      }
    }
  }),

  gitUpdate: tool({
    description: 'Update the local codebase from GitHub. Use this if you believe the remote repository has changes you need (e.g., after a PR merge or when instructed).',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to confirm the update operation')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: gitUpdate');
      try {
        const { stdout: status } = await execAsync('git status --porcelain', { cwd: PIXEL_ROOT });
        if (status.trim()) {
          // We have local changes. Stash them first?
          // For safety, we will abort and ask the agent to commit first via gitSync.
          return {
            success: false,
            message: "Cannot update: You have uncommitted local changes. Please use 'gitSync' to save your work first, or stash them manually."
          };
        }

        console.log('[SYNTROPY] Fetching updates...');
        await execAsync('git fetch origin', { cwd: PIXEL_ROOT });

        const { stdout: behind } = await execAsync('git rev-list HEAD..origin/master --count', { cwd: PIXEL_ROOT });
        const count = parseInt(behind.trim(), 10);

        if (count === 0) {
          return { success: true, message: "Already up to date." };
        }

        console.log(`[SYNTROPY] Pulling ${count} commits...`);
        // We are clean, so rebase should be safe, but --autostash just in case
        const { stdout: pullLog } = await execAsync('git pull --rebase --autostash origin master', { cwd: PIXEL_ROOT });

        // Also update submodules
        await execAsync('git submodule update --init --recursive', { cwd: PIXEL_ROOT });

        await logAudit({ type: 'git_update', commits: count });
        return {
          success: true,
          message: `Successfully updated ${count} commits from origin/master.`,
          details: pullLog
        };
      } catch (error: any) {
        await logAudit({ type: 'git_update_error', error: error.message });
        return { error: `Update failed: ${error.message}` };
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
        if (!fs.existsSync(DB_PATH)) return "Database not found";
        // @ts-ignore
        const { Database } = await import('bun:sqlite');
        db = new Database(DB_PATH);
        const result = db.query('SELECT SUM(sats) as total FROM pixels').get() as any;
        const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get() as any;
        const data = { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
        await logAudit({ type: 'treasury_check', ...data });
        return data;
      } catch (error: any) {
        await logAudit({ type: 'treasury_error', error: error.message });
        return { error: `SQLite error: ${error.message}` };
      } finally {
        if (db) db.close();
      }
    }
  }),

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
      } catch (e: any) {
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

        // Parse and get most recent entries
        const maxLines = Math.min(Math.max(lines, 1), 500);
        const recentEntries = auditLines.slice(-maxLines).map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            return { parse_error: line.substring(0, 100) + '...' };
          }
        });

        await logAudit({ type: 'audit_read', entries_requested: lines, entries_returned: recentEntries.length });
        return recentEntries;
      } catch (error: any) {
        return { error: error.message };
      }
    }
  })
};

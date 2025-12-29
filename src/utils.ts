import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PIXEL_ROOT, AUDIT_LOG_PATH } from './config';

const execAsync = promisify(exec);

const MAX_AUDIT_ENTRIES = 500;

export const logAudit = async (entry: any) => {
  try {
    const newEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };

    // 1. Append the new entry
    const jsonLine = JSON.stringify(newEntry) + '\n';
    await fs.appendFile(AUDIT_LOG_PATH, jsonLine);

    // 2. FIFO Pruning: Keep log length under control
    try {
      const content = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
      const lines = content.trim().split('\n');

      if (lines.length > MAX_AUDIT_ENTRIES) {
        const prunedContent = lines.slice(-MAX_AUDIT_ENTRIES).join('\n') + '\n';
        await fs.writeFile(AUDIT_LOG_PATH, prunedContent);
        // console.log(`[SYNTROPY] Audit log pruned to ${MAX_AUDIT_ENTRIES} entries`);
      }
    } catch (pruneError) {
      // Non-critical error, don't fail the audit write
    }

    console.log(`[SYNTROPY] Audit log updated: ${newEntry.type}`);
  } catch (error: any) {
    console.error('[SYNTROPY] Failed to write audit log:', error.message);
  }
};

export const syncAll = async () => {
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
      if (!fs.existsSync(repo)) continue;
      try {
        // Check if it is a git repo
        if (!fs.existsSync(path.join(repo, '.git'))) continue;

        await execAsync('git add .', { cwd: repo });
        try {
          await execAsync('git commit -m "chore: autonomous sync after mutation"', { cwd: repo });
        } catch (e) {
          // Ignore if no changes to commit
        }

        try {
          const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repo });
          await execAsync(`git push origin ${branch.trim()}`, { cwd: repo });
        } catch (e) {
          // Push might fail if no upstream or auth issues, catch silently to not break loop
        }
      } catch (e) {
        // Ignore general git errors
      }
    }

    console.log('[SYNTROPY] Sync complete.');
    return true;
  } catch (error: any) {
    console.error('[SYNTROPY] Sync failed:', error.message);
    return false;
  }
};

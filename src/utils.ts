import * as fs from 'fs-extra';
import * as path from 'path';
import { execSync } from 'child_process';
import { PIXEL_ROOT, AUDIT_LOG_PATH } from './config';

export const logAudit = async (entry: any) => {
  try {
    let auditLog: any[] = [];
    if (fs.existsSync(AUDIT_LOG_PATH)) {
      const content = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
      try {
        auditLog = JSON.parse(content);
      } catch (e) {
        // If JSON is corrupt, start fresh
        auditLog = [];
      }
    }
    
    const newEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };
    
    auditLog.unshift(newEntry);
    // Keep last 200 entries for better history
    if (auditLog.length > 200) auditLog = auditLog.slice(0, 200);
    
    await fs.writeJson(AUDIT_LOG_PATH, auditLog, { spaces: 2 });
    console.log(`[SYNTROPY] Audit log updated: ${newEntry.type}`);
  } catch (error: any) {
    console.error('[SYNTROPY] Failed to write audit log:', error.message);
  }
};

export const syncAll = () => {
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

        execSync('git add .', { cwd: repo, stdio: 'ignore' });
        try {
            execSync('git commit -m "chore: autonomous sync after mutation"', { cwd: repo, stdio: 'ignore' });
        } catch (e) {
            // Ignore if no changes to commit
        }
        
        try {
             const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim();
             execSync(`git push origin ${branch}`, { cwd: repo, stdio: 'ignore' });
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

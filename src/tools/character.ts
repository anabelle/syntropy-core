import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  PIXEL_AGENT_DIR,
  CHARACTER_DIR,
  LOG_PATH,
  AUDIT_LOG_PATH
} from '../config';
import { logAudit, syncAll } from '../utils';

const execAsync = promisify(exec);
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
const CONTINUITY_PATH = isDocker
  ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
  : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');

export const characterTools = {
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
    description: 'Mutate a specific part of Pixel\'s character DNA. Automatically builds and reboots the agent. Includes pre-flight checks, syntax validation, and post-restart verification.',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts']),
      content: z.string().describe('The full content of the file to write')
    }),
    execute: async ({ file, content }) => {
      console.log(`[SYNTROPY] Tool: mutateCharacter (${file})`);
      const filePath = path.resolve(CHARACTER_DIR, file);
      const tempFilePath = filePath + '.tmp';
      const backupFilePath = filePath + '.bak';
      const varName = file.split('.')[0];
      let oldContent = "";

      // Helper: wait for agent health
      const waitForAgentHealth = async (maxAttempts = 10, delayMs = 3000): Promise<boolean> => {
        for (let i = 0; i < maxAttempts; i++) {
          try {
            const { stdout } = await execAsync('docker inspect --format="{{.State.Health.Status}}" pixel-agent-1', { timeout: 5000 });
            const status = stdout.trim();
            if (status === 'healthy') {
              console.log(`[SYNTROPY] Agent healthy after ${i + 1} checks`);
              return true;
            }
            // Also accept 'starting' if container is running
            if (status === 'starting') {
              console.log(`[SYNTROPY] Agent starting, waiting... (attempt ${i + 1}/${maxAttempts})`);
            }
          } catch {
            // Container might not have healthcheck, check if running
            try {
              const { stdout } = await execAsync('docker inspect --format="{{.State.Running}}" pixel-agent-1', { timeout: 5000 });
              if (stdout.trim() === 'true') {
                // Give it a moment to stabilize
                await new Promise(r => setTimeout(r, delayMs));
                console.log(`[SYNTROPY] Agent running (no healthcheck), assuming ready`);
                return true;
              }
            } catch { /* ignore */ }
          }
          await new Promise(r => setTimeout(r, delayMs));
        }
        return false;
      };

      try {
        // === PRE-FLIGHT CHECKS ===
        console.log('[SYNTROPY] Running pre-flight checks...');

        // 1a. Check Docker is accessible
        try {
          await execAsync('docker info', { timeout: 10000 });
        } catch (dockerErr: any) {
          await logAudit({ type: 'mutation_preflight_fail', file, error: 'Docker not accessible' });
          return { error: 'Pre-flight failed: Docker is not accessible. Cannot proceed with mutation.' };
        }

        // 1b. Check agent container exists
        try {
          const { stdout } = await execAsync('docker ps -a --filter name=pixel-agent-1 --format "{{.Names}}"', { timeout: 5000 });
          if (!stdout.includes('pixel-agent-1')) {
            await logAudit({ type: 'mutation_preflight_fail', file, error: 'Agent container not found' });
            return { error: 'Pre-flight failed: pixel-agent-1 container not found.' };
          }
        } catch {
          await logAudit({ type: 'mutation_preflight_fail', file, error: 'Failed to check container' });
          return { error: 'Pre-flight failed: Could not verify agent container status.' };
        }

        // 1c. Check character directory exists
        if (!await fs.pathExists(CHARACTER_DIR)) {
          await logAudit({ type: 'mutation_preflight_fail', file, error: 'Character dir missing' });
          return { error: `Pre-flight failed: Character directory not found at ${CHARACTER_DIR}` };
        }

        // === VALIDATION ===
        // 2a. Basic export validation
        const exportRegex = new RegExp(`export\\s+(const|let|var)\\s+${varName}\\b`, 'm');
        if (!exportRegex.test(content)) {
          return { error: `Validation failed: Content must export '${varName}'` };
        }

        // 2b. TypeScript syntax validation (write to temp, check with bun)
        console.log('[SYNTROPY] Validating TypeScript syntax...');
        await fs.writeFile(tempFilePath, content);
        try {
          await execAsync(`bun build --no-bundle "${tempFilePath}" --outdir /tmp/mutation-check`, { timeout: 30000 });
        } catch (syntaxErr: any) {
          await fs.remove(tempFilePath);
          await logAudit({ type: 'mutation_syntax_fail', file, error: syntaxErr.message });
          return { error: `TypeScript syntax validation failed: ${syntaxErr.message.slice(0, 200)}` };
        }

        // === BACKUP ===
        // 3. Backup current file (not just in memory, also on disk)
        if (await fs.pathExists(filePath)) {
          oldContent = await fs.readFile(filePath, 'utf-8');
          await fs.copy(filePath, backupFilePath);
          console.log(`[SYNTROPY] Backed up ${file} to ${file}.bak`);
        }

        await logAudit({ type: 'mutation_start', file });

        // === ATOMIC WRITE ===
        // 4. Rename temp file to target (atomic on most filesystems)
        await fs.rename(tempFilePath, filePath);
        console.log(`[SYNTROPY] Wrote ${file} atomically`);

        try {
          // === BUILD VALIDATION ===
          // 5. Validate build ecosystem-wide
          console.log('[SYNTROPY] Validating mutation build...');
          await execAsync('./scripts/validate-build.sh', { cwd: PIXEL_ROOT, timeout: 300000 });

          // 6. Build agent specifically
          console.log('[SYNTROPY] Building agent...');
          await execAsync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });

          // === RESTART WITH HEALTH CHECK ===
          // 7. Restart agent
          console.log('[SYNTROPY] Restarting agent...');
          await execAsync('docker restart pixel-agent-1', { timeout: 30000 });

          // 8. Wait for agent to become healthy
          console.log('[SYNTROPY] Waiting for agent health...');
          const isHealthy = await waitForAgentHealth(15, 2000); // 15 attempts, 2s each = 30s max

          if (!isHealthy) {
            throw new Error('Agent failed to become healthy after restart');
          }

          // === SUCCESS ===
          // 9. Clean up backup and sync
          await fs.remove(backupFilePath);
          await syncAll({ reason: `feat(pixel-agent): mutate ${file}` });
          await logAudit({ type: 'mutation_success', file });

          return { success: true, mutatedFile: file, verified: true };

        } catch (buildError: any) {
          // === ROLLBACK ===
          console.error(`[SYNTROPY] Mutation failed: ${buildError.message}. Rolling back...`);

          // Restore from backup file (more reliable than memory)
          if (await fs.pathExists(backupFilePath)) {
            await fs.copy(backupFilePath, filePath);
            await fs.remove(backupFilePath);
            console.log(`[SYNTROPY] Restored ${file} from backup`);

            // Try to restart with old content
            try {
              await execAsync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
              await execAsync('docker restart pixel-agent-1', { timeout: 30000 });
              await waitForAgentHealth(10, 2000);
            } catch (restoreErr: any) {
              console.error(`[SYNTROPY] Warning: Rollback build/restart failed: ${restoreErr.message}`);
            }
          } else if (oldContent) {
            // Fallback to memory backup
            await fs.writeFile(filePath, oldContent);
          }

          await logAudit({ type: 'mutation_rollback', file, error: buildError.message });
          return { error: `Mutation failed validation. Reverted to previous stable version. Error: ${buildError.message}` };
        }

      } catch (error: any) {
        // Clean up temp/backup files on unexpected error
        await fs.remove(tempFilePath).catch(() => { });
        await fs.remove(backupFilePath).catch(() => { });
        await logAudit({ type: 'mutation_error', file, error: error.message });
        return { error: `Mutation process failed: ${error.message}` };
      }
    }
  }),

  writeEvolutionReport: tool({
    description: `Write an evolution report. Use sparingly - only for significant events:
- Successful code mutations or fixes
- Critical errors discovered and resolved  
- Major architectural decisions
- Treasury milestones (e.g., crossed 100k sats)
Do NOT write reports for routine health checks or status updates.`,
    inputSchema: z.object({
      content: z.string().describe('Markdown content of the report'),
      title: z.string().describe('Title of the evolution phase'),
      significance: z.enum(['critical', 'major', 'minor']).describe('How significant is this report? critical=must record, major=important milestone, minor=routine (avoid)')
    }),
    execute: async ({ content, title, significance }) => {
      // Skip minor reports to reduce bloat
      if (significance === 'minor') {
        console.log(`[SYNTROPY] Skipping minor evolution report: ${title}`);
        return { success: true, skipped: true, reason: 'Minor reports are not persisted to reduce bloat' };
      }

      console.log(`[SYNTROPY] Tool: writeEvolutionReport (${title}) [${significance}]`);
      await logAudit({ type: 'evolution_report', title, significance });
      try {
        const reportDir = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/evolution')
          : path.resolve(PIXEL_ROOT, 'docs/evolution');
        await fs.ensureDir(reportDir);
        const filename = `${Date.now()}-${title.toLowerCase().replace(/\\s+/g, '-')}.md`;
        await fs.writeFile(path.resolve(reportDir, filename), content);

        // Auto-prune: Keep only the last 10 reports
        const MAX_REPORTS = 10;
        const files = await fs.readdir(reportDir);
        const mdFiles = files.filter(f => f.endsWith('.md')).sort();
        if (mdFiles.length > MAX_REPORTS) {
          const toDelete = mdFiles.slice(0, mdFiles.length - MAX_REPORTS);
          for (const file of toDelete) {
            await fs.remove(path.resolve(reportDir, file));
            console.log(`[SYNTROPY] Pruned old evolution report: ${file}`);
          }
        }

        const syntropyJsonPath = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/syntropy.json')
          : path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');

        await fs.writeJson(syntropyJsonPath, {
          lastUpdate: new Date().toISOString(),
          title,
          content,
          significance,
          status: 'EVOLUTION_STEP_COMPLETE'
        });
        return { success: true };
      } catch (error: any) {
        await logAudit({ type: 'report_error', title, error: error.message });
        return { error: error.message };
      }
    }
  })
};

import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT, PIXEL_AGENT_DIR, CHARACTER_DIR } from '../config';
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
            }
            catch (error) {
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
            const filePath = path.resolve(CHARACTER_DIR, file);
            const varName = file.split('.')[0];
            let oldContent = "";
            try {
                // 1. Validation de base
                const exportRegex = new RegExp(`export\\s+(const|let|var)\\s+${varName}\\b`, 'm');
                if (!exportRegex.test(content)) {
                    return { error: `Validation failed: Content must export '${varName}'` };
                }
                // 2. Backup old content
                if (fs.existsSync(filePath)) {
                    oldContent = await fs.readFile(filePath, 'utf-8');
                }
                await logAudit({ type: 'mutation_start', file });
                // 3. Write new content
                await fs.writeFile(filePath, content);
                try {
                    // 4. Validate build ecosystem-wide
                    console.log('[SYNTROPY] Validating mutation build...');
                    await execAsync('./scripts/validate-build.sh', { cwd: PIXEL_ROOT, timeout: 300000 });
                    // 5. Build agent specifically and restart
                    await execAsync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
                    await execAsync('docker restart pixel-agent-1', { timeout: 20000 });
                    await syncAll({ reason: `feat(pixel-agent): mutate ${file}` });
                    await logAudit({ type: 'mutation_success', file });
                    return { success: true, mutatedFile: file };
                }
                catch (buildError) {
                    // 6. Rollback
                    console.error(`[SYNTROPY] Mutation build failed: ${buildError.message}. Rolling back...`);
                    if (oldContent) {
                        await fs.writeFile(filePath, oldContent);
                    }
                    await logAudit({ type: 'mutation_rollback', file, error: buildError.message });
                    return { error: `Mutation failed validation. Reverted to previous stable version. Error: ${buildError.message}` };
                }
            }
            catch (error) {
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
            }
            catch (error) {
                await logAudit({ type: 'report_error', title, error: error.message });
                return { error: error.message };
            }
        }
    })
};

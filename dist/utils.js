import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PIXEL_ROOT, AUDIT_LOG_PATH } from './config';
const execAsync = promisify(exec);
const MAX_AUDIT_ENTRIES = 500;
export const logAudit = async (entry) => {
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
        }
        catch (pruneError) {
            // Non-critical error, don't fail the audit write
        }
        console.log(`[SYNTROPY] Audit log updated: ${newEntry.type}`);
    }
    catch (error) {
        console.error('[SYNTROPY] Failed to write audit log:', error.message);
    }
};
export const syncAll = async () => {
    console.log('[SYNTROPY] Initiating ecosystem-wide GitHub sync...');
    try {
        const submodules = [
            'lnpixels',
            'pixel-agent',
            'pixel-landing',
            'syntropy-core'
        ];
        // Configure git for container environment
        const ghToken = process.env.GH_TOKEN;
        if (!ghToken) {
            console.warn('[SYNTROPY] GH_TOKEN not set - git push will fail');
        }
        // Step 1: Push each submodule first
        for (const submodule of submodules) {
            const repo = path.resolve(PIXEL_ROOT, submodule);
            if (!fs.existsSync(repo))
                continue;
            try {
                if (!fs.existsSync(path.join(repo, '.git')))
                    continue;
                // Mark directory as safe
                await execAsync(`git config --global --add safe.directory ${repo}`, { cwd: repo }).catch(() => { });
                // Configure credential helper if token available
                if (ghToken) {
                    await execAsync(`git config credential.helper '!f() { echo "password=${ghToken}"; }; f'`, { cwd: repo }).catch(() => { });
                }
                await execAsync('git add .', { cwd: repo });
                try {
                    await execAsync('git commit -m "chore(syntropy): autonomous sync [skip ci]"', { cwd: repo });
                    console.log(`[SYNTROPY] Committed changes in ${submodule}`);
                }
                catch (e) {
                    // No changes to commit
                }
                try {
                    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repo });
                    await execAsync(`git push origin ${branch.trim()}`, { cwd: repo });
                    console.log(`[SYNTROPY] Pushed ${submodule}`);
                }
                catch (e) {
                    console.warn(`[SYNTROPY] Push failed for ${submodule}: ${e.message}`);
                }
            }
            catch (e) {
                // Ignore general git errors
            }
        }
        // Step 2: Update parent repo with new submodule pointers
        try {
            await execAsync(`git config --global --add safe.directory ${PIXEL_ROOT}`, { cwd: PIXEL_ROOT }).catch(() => { });
            if (ghToken) {
                await execAsync(`git config credential.helper '!f() { echo "password=${ghToken}"; }; f'`, { cwd: PIXEL_ROOT }).catch(() => { });
            }
            // Stage submodule pointer updates
            for (const submodule of submodules) {
                await execAsync(`git add ${submodule}`, { cwd: PIXEL_ROOT }).catch(() => { });
            }
            // Also add any other changes in parent repo
            await execAsync('git add .', { cwd: PIXEL_ROOT });
            try {
                await execAsync('git commit -m "chore(syntropy): update submodule refs [skip ci]"', { cwd: PIXEL_ROOT });
                console.log('[SYNTROPY] Committed submodule updates in parent');
            }
            catch (e) {
                // No changes
            }
            try {
                const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: PIXEL_ROOT });
                await execAsync(`git push origin ${branch.trim()}`, { cwd: PIXEL_ROOT });
                console.log('[SYNTROPY] Pushed parent repo');
            }
            catch (e) {
                console.warn(`[SYNTROPY] Push failed for parent: ${e.message}`);
            }
        }
        catch (e) {
            // Parent sync error
        }
        console.log('[SYNTROPY] Sync complete.');
        return true;
    }
    catch (error) {
        console.error('[SYNTROPY] Sync failed:', error.message);
        return false;
    }
};

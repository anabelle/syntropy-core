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
export const syncAll = async (context) => {
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
        // Generate commit message based on context
        const generateCommitMessage = async (repoPath, isSubmodule) => {
            // If explicit reason provided, use it
            if (context?.reason) {
                return context.reason;
            }
            // Otherwise, analyze the diff to generate a meaningful message
            try {
                const { stdout: diffStat } = await execAsync('git diff --cached --stat', { cwd: repoPath });
                const { stdout: diffFiles } = await execAsync('git diff --cached --name-only', { cwd: repoPath });
                const files = diffFiles.trim().split('\n').filter(Boolean);
                if (files.length === 0) {
                    return 'chore(syntropy): no changes';
                }
                // Categorize changes
                const categories = {
                    docs: [],
                    src: [],
                    config: [],
                    build: [],
                    other: []
                };
                for (const file of files) {
                    if (file.match(/\.(md|txt)$/i) || file.includes('docs/')) {
                        categories.docs.push(file);
                    }
                    else if (file.match(/\.(ts|js|tsx|jsx)$/) && (file.includes('src/') || file.includes('lib/'))) {
                        categories.src.push(file);
                    }
                    else if (file.match(/\.(json|ya?ml|toml|env)$|config/i)) {
                        categories.config.push(file);
                    }
                    else if (file.includes('dist/') || file.includes('build/')) {
                        categories.build.push(file);
                    }
                    else {
                        categories.other.push(file);
                    }
                }
                // Generate message based on what changed
                const parts = [];
                if (categories.src.length > 0) {
                    const mainFile = path.basename(categories.src[0], path.extname(categories.src[0]));
                    parts.push(`update ${mainFile}${categories.src.length > 1 ? ` +${categories.src.length - 1}` : ''}`);
                }
                if (categories.docs.length > 0) {
                    parts.push(`docs`);
                }
                if (categories.config.length > 0) {
                    parts.push(`config`);
                }
                if (categories.build.length > 0 && parts.length === 0) {
                    parts.push(`build outputs`);
                }
                if (parts.length === 0) {
                    parts.push(`${files.length} file${files.length > 1 ? 's' : ''}`);
                }
                const scope = isSubmodule ? path.basename(repoPath) : 'pixel';
                return `chore(${scope}): ${parts.join(', ')} [skip ci]`;
            }
            catch (e) {
                // Fallback to generic message
                return isSubmodule
                    ? `chore(${path.basename(repoPath)}): sync [skip ci]`
                    : 'chore(syntropy): update submodule refs [skip ci]';
            }
        };
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
                // Generate smart commit message
                const commitMsg = await generateCommitMessage(repo, true);
                try {
                    await execAsync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repo });
                    console.log(`[SYNTROPY] Committed changes in ${submodule}: ${commitMsg}`);
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
            // Generate smart commit message for parent
            const parentCommitMsg = await generateCommitMessage(PIXEL_ROOT, false);
            try {
                await execAsync(`git commit -m "${parentCommitMsg.replace(/"/g, '\\"')}"`, { cwd: PIXEL_ROOT });
                console.log(`[SYNTROPY] Committed in parent: ${parentCommitMsg}`);
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

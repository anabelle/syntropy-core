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
    console.log('[SYNTROPY] Initiating Ultra-Resilient Ecosystem Sync...');
    const MAX_RETRIES = 3;
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
            console.warn('[SYNTROPY] GH_TOKEN not set - operations requiring auth will fail');
        }
        const configureGit = async (cwd) => {
            try {
                await execAsync(`git config --global --add safe.directory ${cwd}`, { cwd }).catch(() => { });
                if (ghToken) {
                    await execAsync(`git config credential.helper '!f() { echo "password=${ghToken}"; }; f'`, { cwd }).catch(() => { });
                }
                // Ensure we track remote properly
                await execAsync('git config pull.rebase true', { cwd }).catch(() => { });
            }
            catch (e) {
                // Ignore config errors
            }
        };
        const handleRepoSync = async (repoPath, isSubmodule) => {
            if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git')))
                return false;
            const repoName = path.basename(repoPath);
            console.log(`[SYNTROPY] 🔄 Syncing ${repoName}...`);
            await configureGit(repoPath);
            try {
                // 1. STAGE & COMMIT LOCAL CHANGES
                await execAsync('git add .', { cwd: repoPath });
                // Generate message
                let commitMsg = '';
                if (context?.reason) {
                    commitMsg = context.reason;
                }
                else {
                    // Quick diff check to see if we need to generate a message
                    try {
                        const { stdout } = await execAsync('git diff --cached --name-only', { cwd: repoPath });
                        if (stdout.trim()) {
                            // Determine scope
                            const isDocs = stdout.includes('.md') || stdout.includes('docs/');
                            const isSrc = stdout.includes('.ts') || stdout.includes('.js');
                            const type = isDocs ? 'docs' : 'feat';
                            const scope = isSubmodule ? repoName : 'pixel';
                            commitMsg = `${type}(${scope}): auto-sync ${new Date().toISOString()}`;
                        }
                    }
                    catch (e) { }
                }
                if (commitMsg) {
                    try {
                        await execAsync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repoPath });
                        console.log(`[SYNTROPY] ✅ Committed ${repoName}: ${commitMsg}`);
                    }
                    catch (e) {
                        // Nothing to commit, which is fine
                    }
                }
                // Detect current branch
                const { stdout: currentBranchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
                const currentBranch = currentBranchRaw.trim();
                // 2. PULL & REBASE (Bidirectional Sync)
                // We try to pull changes from remote before pushing to avoid non-fast-forward errors
                try {
                    console.log(`[SYNTROPY] ⬇️  Pulling latest for ${repoName} (${currentBranch})...`);
                    await execAsync(`git pull --rebase --autostash origin ${currentBranch}`, { cwd: repoPath });
                }
                catch (pullError) {
                    console.warn(`[SYNTROPY] ⚠️ Conflict detected during pull in ${repoName}.`);
                    // Strategy: Create a conflict branch and push that instead of breaking local state
                    const conflictBranch = `conflict/${repoName}-${Date.now()}`;
                    await execAsync(`git checkout -b ${conflictBranch}`, { cwd: repoPath });
                    await execAsync('git commit -am "chore: conflict resolution save point"', { cwd: repoPath }).catch(() => { });
                    await execAsync(`git push -u origin ${conflictBranch}`, { cwd: repoPath });
                    console.warn(`[SYNTROPY] 🚨 Created conflict branch: ${conflictBranch}. Resetting ${currentBranch} to origin.`);
                    // Hard reset primary branch to origin to get back in sync
                    await execAsync(`git checkout ${currentBranch}`, { cwd: repoPath });
                    await execAsync('git fetch origin', { cwd: repoPath });
                    await execAsync(`git reset --hard origin/${currentBranch}`, { cwd: repoPath });
                    return false; // Stop processing this repo for now
                }
                // 3. PUSH
                try {
                    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
                    await execAsync(`git push origin ${branch.trim()}`, { cwd: repoPath });
                    console.log(`[SYNTROPY] 🚀 Pushed ${repoName}`);
                    return true;
                }
                catch (pushError) {
                    console.error(`[SYNTROPY] ❌ Push failed for ${repoName}: ${pushError.message}`);
                    return false;
                }
            }
            catch (error) {
                console.error(`[SYNTROPY] Error processing ${repoName}: ${error.message}`);
                return false;
            }
        };
        // PROCESS SUBMODULES
        for (const submodule of submodules) {
            await handleRepoSync(path.resolve(PIXEL_ROOT, submodule), true);
        }
        // PROCESS ROOT
        // For root, we need to handle the updated submodule pointers!
        await configureGit(PIXEL_ROOT);
        // Explicitly add submodules to stage their pointer updates
        for (const sub of submodules) {
            await execAsync(`git add ${sub}`, { cwd: PIXEL_ROOT }).catch(() => { });
        }
        await handleRepoSync(PIXEL_ROOT, false);
        console.log('[SYNTROPY] Ecosystem Sync Complete.');
        return true;
    }
    catch (error) {
        console.error('[SYNTROPY] Sync Fatal Error:', error.message);
        return false;
    }
};

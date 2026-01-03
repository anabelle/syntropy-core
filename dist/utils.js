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
        const ensureCleanBranchState = async (repoPath, repoName) => {
            try {
                const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
                const branch = branchRaw.trim();
                if (branch.startsWith('conflict/')) {
                    console.warn(`[SYNTROPY] 🚨 DETECTED STUCK CONFLICT BRANCH: ${branch} in ${repoName}`);
                    // Get the default branch from remote
                    let target = 'master'; // fallback
                    try {
                        const { stdout: remoteInfo } = await execAsync('git remote show origin', { cwd: repoPath });
                        const headMatch = remoteInfo.match(/HEAD branch:\s*(\S+)/);
                        if (headMatch) {
                            target = headMatch[1];
                        }
                    }
                    catch (e) {
                        // Fallback: check if main or master exists
                        const { stdout: branchesRaw } = await execAsync('git branch --format="%(refname:short)"', { cwd: repoPath });
                        const branches = branchesRaw.split('\n').map(b => b.trim());
                        target = branches.includes('main') ? 'main' : 'master';
                    }
                    console.log(`[SYNTROPY] 🚑 Self-healing: Force switching back to ${target}...`);
                    await execAsync(`git checkout -f ${target}`, { cwd: repoPath });
                    await execAsync(`git reset --hard origin/${target}`, { cwd: repoPath }).catch(() => { });
                    console.log(`[SYNTROPY] ✅ Restored ${repoName} to ${target}`);
                }
            }
            catch (e) {
                console.warn(`[SYNTROPY] Self-healing check failed for ${repoName}: ${e.message}`);
            }
        };
        const handleRepoSync = async (repoPath, isSubmodule) => {
            if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.git')))
                return false;
            const repoName = path.basename(repoPath);
            console.log(`[SYNTROPY] 🔄 Syncing ${repoName}...`);
            // 0. SELF-HEAL: Check if we are stuck on a conflict branch from a previous crash
            await ensureCleanBranchState(repoPath, repoName);
            await configureGit(repoPath);
            try {
                // Detect current branch first
                const { stdout: currentBranchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath });
                const currentBranch = currentBranchRaw.trim();
                // 1. FETCH REMOTE to see what's ahead
                await execAsync(`git fetch origin ${currentBranch}`, { cwd: repoPath });
                // 2. STAGE & COMMIT LOCAL CHANGES
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
                // 3. REBASE onto remote to maintain linear history
                // This is the key change: instead of creating conflict branches, we rebase
                try {
                    console.log(`[SYNTROPY] ⬇️  Rebasing ${repoName} onto origin/${currentBranch}...`);
                    await execAsync(`git rebase origin/${currentBranch}`, { cwd: repoPath });
                }
                catch (rebaseError) {
                    console.warn(`[SYNTROPY] ⚠️ Rebase conflict in ${repoName}. Aborting and resetting to remote.`);
                    // Abort the rebase and reset to remote - remote is source of truth
                    await execAsync('git rebase --abort', { cwd: repoPath }).catch(() => { });
                    await execAsync(`git reset --hard origin/${currentBranch}`, { cwd: repoPath });
                    console.warn(`[SYNTROPY] 🔄 Reset ${repoName} to origin/${currentBranch}. Local changes were discarded.`);
                    return false;
                }
                // 4. PUSH (should always be fast-forward now)
                try {
                    await execAsync(`git push origin ${currentBranch}`, { cwd: repoPath });
                    console.log(`[SYNTROPY] 🚀 Pushed ${repoName}`);
                    return true;
                }
                catch (pushError) {
                    // If push still fails, force-reset to remote
                    console.warn(`[SYNTROPY] ⚠️ Push failed for ${repoName}: ${pushError.message}. Resetting to remote.`);
                    await execAsync(`git reset --hard origin/${currentBranch}`, { cwd: repoPath });
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

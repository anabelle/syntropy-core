import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PIXEL_ROOT, AUDIT_LOG_PATH } from './config';

const execAsync = promisify(exec);

export const getAgentContainerName = async (): Promise<string> => {
  try {
    const { stdout } = await execAsync('docker ps --filter "label=com.docker.compose.service=agent" --format "{{.Names}}"');
    const name = stdout.trim();
    if (name) {
      // If multiple containers found (rare), take the first one
      return name.split('\n')[0];
    }
    return 'pixel-agent-1'; // Fallback
  } catch {
    return 'pixel-agent-1';
  }
};

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

export const syncAll = async (context?: { reason?: string; files?: string[] }) => {
  console.log('[SYNTROPY] Initiating ecosystem-wide GitHub sync...');
  try {
    const submodules = [
      'lnpixels',
      'pixel-agent',
      'pixel-landing',
      'syntropy-core'
    ];

    // Configure git for container environment
    const ghToken = process.env.GH_TOKEN?.trim();
    if (!ghToken) {
      console.warn('[SYNTROPY] GH_TOKEN not set - git push will fail');
    }

    const execOpts = {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
    } as const;

    const isNonFastForward = (error: any): boolean => {
      const combined = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`.toLowerCase();
      return (
        combined.includes('non-fast-forward') ||
        combined.includes('fetch first') ||
        combined.includes('rejected') && combined.includes('non-fast-forward')
      );
    };

    const isRebaseInProgress = (repoPath: string): boolean => {
      try {
        const gitDir = fs.existsSync(path.join(repoPath, '.git'))
          ? path.join(repoPath, '.git')
          : repoPath;
        return (
          fs.existsSync(path.join(gitDir, 'rebase-apply')) ||
          fs.existsSync(path.join(gitDir, 'rebase-merge'))
        );
      } catch {
        return false;
      }
    };

    const attemptRebaseOntoOrigin = async (repoPath: string, branchHint?: string) => {
      const defaultBranch = branchHint || await getDefaultBranch(repoPath);
      if (isRebaseInProgress(repoPath)) {
        console.warn(`[SYNTROPY] Rebase already in progress in ${path.basename(repoPath)}; skipping rebase.`);
        return;
      }

      try {
        await execAsync('git fetch origin --prune', { cwd: repoPath, ...execOpts });
      } catch {
        // ignore
      }

      const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, ...execOpts });
      const branch = branchRaw.trim();

      if (branch === 'HEAD') {
        // Detached HEAD: rebase current commits onto origin/defaultBranch
        await execAsync(`git rebase origin/${defaultBranch}`, { cwd: repoPath, ...execOpts });
      } else {
        // On a branch: rebase onto upstream while stashing local working changes if needed
        await execAsync(`git pull --rebase --autostash origin ${branch}`, { cwd: repoPath, ...execOpts });
      }
    };

    const isNothingToCommit = (error: any): boolean => {
      const combined = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`.toLowerCase();
      return (
        combined.includes('nothing to commit') ||
        combined.includes('no changes added to commit') ||
        combined.includes('working tree clean')
      );
    };

    const getDefaultBranch = async (repoPath: string): Promise<string> => {
      try {
        const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: repoPath, ...execOpts });
        const ref = stdout.trim();
        const parts = ref.split('/');
        const last = parts[parts.length - 1];
        if (last) return last;
      } catch {
        // ignore
      }

      try {
        const { stdout } = await execAsync('git remote show origin', { cwd: repoPath, ...execOpts });
        const match = stdout.match(/HEAD branch:\s*(.+)\s*$/m);
        if (match?.[1]) return match[1].trim();
      } catch {
        // ignore
      }

      for (const candidate of ['main', 'master']) {
        try {
          await execAsync(`git show-ref --verify --quiet refs/remotes/origin/${candidate}`,
            { cwd: repoPath, ...execOpts }
          );
          return candidate;
        } catch {
          // ignore
        }
      }

      return 'main';
    };

    const ensureGitHubHttpsPush = async (repoPath: string) => {
      if (!ghToken) return;
      try {
        const { stdout: pushUrlRaw } = await execAsync('git remote get-url --push origin', { cwd: repoPath, ...execOpts });
        const pushUrl = pushUrlRaw.trim();
        if (!pushUrl) return;

        let httpsUrl: string | null = null;
        if (pushUrl.startsWith('git@github.com:')) {
          httpsUrl = `https://github.com/${pushUrl.slice('git@github.com:'.length)}`;
        } else if (pushUrl.startsWith('ssh://git@github.com/')) {
          httpsUrl = `https://github.com/${pushUrl.slice('ssh://git@github.com/'.length)}`;
        }

        if (httpsUrl) {
          await execAsync(`git remote set-url --push origin ${httpsUrl}`, { cwd: repoPath, ...execOpts });
        }
      } catch {
        // ignore
      }
    };

    // Ensure commits succeed even in fresh containers
    await execAsync('git config --global user.name "Syntropy Bot"', execOpts).catch(() => { });
    await execAsync('git config --global user.email "syntropy@pixel.xx.kg"', execOpts).catch(() => { });

    // Configure GitHub HTTPS auth when GH_TOKEN is present.
    // This avoids SSH deploy-key failures and makes pushes work across all repos.
    if (ghToken) {
      const basicAuth = Buffer.from(`x-access-token:${ghToken}`).toString('base64');
      const header = `AUTHORIZATION: basic ${basicAuth}`;
      await execAsync(`git config --global http.https://github.com/.extraheader "${header}"`, execOpts).catch(() => { });
    }

    // Generate commit message based on context
    const generateCommitMessage = async (repoPath: string, isSubmodule: boolean): Promise<string> => {
      // If explicit reason provided, use it, but ensure [skip cd] is appended
      if (context?.reason) {
        let msg = context.reason;
        if (!msg.includes('[skip cd]')) {
          msg += ' [skip cd]';
        }
        return msg;
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
        const categories: Record<string, string[]> = {
          docs: [],
          src: [],
          config: [],
          build: [],
          other: []
        };

        for (const file of files) {
          if (file.match(/\.(md|txt)$/i) || file.includes('docs/')) {
            categories.docs.push(file);
          } else if (file.match(/\.(ts|js|tsx|jsx)$/) && (file.includes('src/') || file.includes('lib/'))) {
            categories.src.push(file);
          } else if (file.match(/\.(json|ya?ml|toml|env)$|config/i)) {
            categories.config.push(file);
          } else if (file.includes('dist/') || file.includes('build/')) {
            categories.build.push(file);
          } else {
            categories.other.push(file);
          }
        }

        // Generate message based on what changed
        const parts: string[] = [];
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
        return `chore(${scope}): ${parts.join(', ')} [skip cd]`;
      } catch (e) {
        // Fallback to generic message
        return isSubmodule
          ? `chore(${path.basename(repoPath)}): sync [skip cd]`
          : 'chore(syntropy): update submodule refs [skip cd]';
      }
    };

    // Step 1: Push each submodule first
    for (const submodule of submodules) {
      const repo = path.resolve(PIXEL_ROOT, submodule);
      if (!fs.existsSync(repo)) continue;
      try {
        if (!fs.existsSync(path.join(repo, '.git'))) continue;

        // Mark directory as safe
        await execAsync(`git config --global --add safe.directory ${repo}`, { cwd: repo, ...execOpts }).catch(() => { });
        await ensureGitHubHttpsPush(repo);

        await execAsync('git add .', { cwd: repo, ...execOpts });

        // Generate smart commit message
        const commitMsg = await generateCommitMessage(repo, true);

        try {
          // --no-verify skips pre-commit hooks which can block automated commits
          await execAsync(`git commit --no-verify -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: repo, ...execOpts });
          console.log(`[SYNTROPY] Committed changes in ${submodule}: ${commitMsg}`);
        } catch (e: any) {
          if (!isNothingToCommit(e)) {
            console.warn(`[SYNTROPY] Commit failed for ${submodule}: ${(e?.stderr || e?.message || '').toString().trim()}`);
            // Avoid leaving the repo perpetually staged if commit fails for reasons other than "nothing to commit"
            await execAsync('git reset', { cwd: repo, ...execOpts }).catch(() => { });
          }
        }

        try {
          const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repo, ...execOpts });
          const branch = branchRaw.trim();

          const doPush = async () => {
            if (branch === 'HEAD') {
              const defaultBranch = await getDefaultBranch(repo);
              await execAsync(`git push origin HEAD:${defaultBranch}`, { cwd: repo, ...execOpts });
              // Move detached HEAD onto the default branch after a successful push
              await execAsync(`git checkout -B ${defaultBranch} origin/${defaultBranch}`, { cwd: repo, ...execOpts }).catch(() => { });
            } else {
              await execAsync(`git push origin ${branch}`, { cwd: repo, ...execOpts });
            }
          };

          try {
            await doPush();
          } catch (e: any) {
            if (isNonFastForward(e)) {
              console.warn(`[SYNTROPY] Push rejected for ${submodule}; rebasing and retrying once...`);
              try {
                await attemptRebaseOntoOrigin(repo);
                await doPush();
              } catch (rebaseErr: any) {
                console.warn(`[SYNTROPY] Retry failed for ${submodule}: ${(rebaseErr?.stderr || rebaseErr?.message || '').toString().trim()}`);
                throw rebaseErr;
              }
            } else {
              throw e;
            }
          }

          console.log(`[SYNTROPY] Pushed ${submodule}`);
        } catch (e: any) {
          console.warn(`[SYNTROPY] Push failed for ${submodule}: ${(e?.stderr || e?.message || '').toString().trim()}`);
        }
      } catch (e) {
        // Ignore general git errors
      }
    }

    // Step 2: Update parent repo with new submodule pointers
    try {
      await execAsync(`git config --global --add safe.directory ${PIXEL_ROOT}`, { cwd: PIXEL_ROOT, ...execOpts }).catch(() => { });
      await ensureGitHubHttpsPush(PIXEL_ROOT);

      // Stage submodule pointer updates
      for (const submodule of submodules) {
        await execAsync(`git add ${submodule}`, { cwd: PIXEL_ROOT, ...execOpts }).catch(() => { });
      }

      // Also add any other changes in parent repo
      await execAsync('git add .', { cwd: PIXEL_ROOT, ...execOpts });

      // Generate smart commit message for parent
      const parentCommitMsg = await generateCommitMessage(PIXEL_ROOT, false);

      try {
        // --no-verify skips pre-commit hooks which can block automated commits
        await execAsync(`git commit --no-verify -m "${parentCommitMsg.replace(/"/g, '\\"')}"`, { cwd: PIXEL_ROOT, ...execOpts });
        console.log(`[SYNTROPY] Committed in parent: ${parentCommitMsg}`);
      } catch (e: any) {
        if (!isNothingToCommit(e)) {
          console.warn(`[SYNTROPY] Commit failed for parent: ${(e?.stderr || e?.message || '').toString().trim()}`);
          await execAsync('git reset', { cwd: PIXEL_ROOT, ...execOpts }).catch(() => { });
        }
      }

      try {
        const { stdout: branchRaw } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: PIXEL_ROOT, ...execOpts });
        const branch = branchRaw.trim();
        const doPush = async () => {
          if (branch === 'HEAD') {
            const defaultBranch = await getDefaultBranch(PIXEL_ROOT);
            await execAsync(`git push origin HEAD:${defaultBranch}`, { cwd: PIXEL_ROOT, ...execOpts });
          } else {
            await execAsync(`git push origin ${branch}`, { cwd: PIXEL_ROOT, ...execOpts });
          }
        };

        try {
          await doPush();
        } catch (e: any) {
          if (isNonFastForward(e)) {
            console.warn('[SYNTROPY] Parent push rejected; rebasing and retrying once...');
            await attemptRebaseOntoOrigin(PIXEL_ROOT, branch === 'HEAD' ? undefined : branch);
            await doPush();
          } else {
            throw e;
          }
        }
        console.log('[SYNTROPY] Pushed parent repo');
      } catch (e: any) {
        console.warn(`[SYNTROPY] Push failed for parent: ${(e?.stderr || e?.message || '').toString().trim()}`);
      }
    } catch (e) {
      // Parent sync error
    }

    console.log('[SYNTROPY] Sync complete.');
    return true;
  } catch (error: any) {
    console.error('[SYNTROPY] Sync failed:', error.message);
    return false;
  }
};

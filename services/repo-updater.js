const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../database');
const gitToBruv = require('./git-to-bruv');

// Import bruv library directly for bruv-native pull/update operations
const BruvRepo = require('../../bruv/src/core/repo');

/**
 * Background auto-updater for mirrored repositories.
 *
 * For bruv repos: re-clones and converts using bruv's own conversion pipeline.
 * For legacy git repos: uses `git remote update` then converts to bruv.
 */
function startAutoUpdater() {
    // Run every 5 minutes
    setInterval(async () => {
        try {
            const allRepos = await db.repos.all();
            const mirroredRepos = allRepos.filter(r => r.value && r.value.importedFrom);

            console.log(`[Repo Updater] Starting background update for ${mirroredRepos.length} mirrored repositories...`);

            for (let i = 0; i < mirroredRepos.length; i++) {
                const repo = mirroredRepos[i].value;
                const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), repo.owner, repo.name);
                if (!repoPath) continue;

                if (fs.existsSync(repoPath)) {
                    console.log(`[Repo Updater] Updating ${repo.owner}/${repo.name}...`);

                    if (gitToBruv.isBruvRepo(repoPath) && repo.importedFrom) {
                        // Re-clone and convert from origin using bruv's cloneAndConvert.
                        // This mirrors the source and converts the result to bruv.
                        const bruvRepo = new BruvRepo(repoPath);
                        const remotes = bruvRepo.listRemotes();
                        const remoteUrl = remotes.origin || repo.importedFrom;

                        if (remoteUrl) {
                            try {
                                // Re-clone mirror into a temp path, then overwrite
                                const tmpPath = repoPath + '.update-tmp';
                                await gitToBruv.cloneAndConvert(remoteUrl, tmpPath, {
                                    isPrivate: repo.isPrivate || false,
                                    author: repo.owner,
                                });
                                // Swap in the updated repo
                                if (fs.existsSync(tmpPath)) {
                                    fs.rmSync(repoPath, { recursive: true, force: true });
                                    fs.renameSync(tmpPath, repoPath);
                                    console.log(`[Repo Updater] Updated ${repo.owner}/${repo.name} via bruv`);
                                }
                            } catch (e) {
                                console.error(`[Repo Updater] bruv update failed for ${repo.owner}/${repo.name}: ${e.message}`);
                                // Cleanup any partial temp clone
                                const tmpPath = repoPath + '.update-tmp';
                                if (fs.existsSync(tmpPath)) {
                                    fs.rmSync(tmpPath, { recursive: true, force: true });
                                }
                            }
                        }
                    } else {
                        // Legacy git bare repo — use git remote update, then convert to bruv
                        const git = spawn('git', ['remote', 'update'], { cwd: repoPath });

                        await new Promise(resolve => {
                            git.on('error', () => resolve());
                            git.on('close', async code => {
                                if (code !== 0) {
                                    console.error(`[Repo Updater] Failed to update ${repo.owner}/${repo.name}. Exit code: ${code}`);
                                }
                                // Auto-convert to bruv after git update
                                const bruvDir = path.join(repoPath, '.bruv');
                                if (!fs.existsSync(bruvDir)) {
                                    try {
                                        await gitToBruv.convertGitToBruv(repoPath);
                                        console.log(`[Repo Updater] Converted ${repo.owner}/${repo.name} to bruv`);
                                    } catch (e) {
                                        console.error(`[Repo Updater] Failed to convert ${repo.owner}/${repo.name}: ${e.message}`);
                                    }
                                }
                                resolve();
                            });
                        });
                    }
                }

                if (i < mirroredRepos.length - 1) {
                    const delay = Math.floor(Math.random() * 2000) + 3000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            console.log(`[Repo Updater] Background update completed.`);
        } catch (err) {
            console.error('[Repo Updater] Error during background update:', err.message);
        }
    }, 5 * 60 * 1000);
}

module.exports = { startAutoUpdater };

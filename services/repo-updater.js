const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../database');
const gitToBruv = require('./git-to-bruv');

function startAutoUpdater() {
    // Run every 5 minutes
    setInterval(async () => {
        try {
            const allRepos = await db.repos.all();
            // Filter only mirrored repositories
            const mirroredRepos = allRepos.filter(r => r.value && r.value.importedFrom);

            console.log(`[Repo Updater] Starting background update for ${mirroredRepos.length} mirrored repositories...`);

            for (let i = 0; i < mirroredRepos.length; i++) {
                const repo = mirroredRepos[i].value;
                const repoPath = gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), repo.owner, repo.name);
                if (!repoPath) continue;

                if (fs.existsSync(repoPath)) {
                    console.log(`[Repo Updater] Updating ${repo.owner}/${repo.name}...`);
                    
                    // Try git remote update (works for bare git repos)
                    const git = spawn('git', ['remote', 'update'], { cwd: repoPath });
                    
                    await new Promise((resolve) => {
                        git.on('close', (code) => {
                            if (code !== 0) {
                                console.error(`[Repo Updater] Failed to update ${repo.owner}/${repo.name}. Exit code: ${code}`);
                            }
                            // Auto-convert to bruv after update
                            const bruvDir = path.join(repoPath, '.bruv');
                            if (!fs.existsSync(bruvDir)) {
                                try {
                                    gitToBruv.convertGitToBruv(repoPath);
                                    console.log(`[Repo Updater] Converted ${repo.owner}/${repo.name} to bruv`);
                                } catch (e) {
                                    console.error(`[Repo Updater] Failed to convert ${repo.owner}/${repo.name}: ${e.message}`);
                                }
                            }
                            resolve();
                        });
                    });
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

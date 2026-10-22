const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../database');
const gitToBruv = require('./git-to-bruv');

// Import bruv library directly for bruv-native pull/update operations
const BruvRepo = require('../../bruv/src/core/repo');
const { readJson, writeJson } = require('../../bruv/src/utils/fs');

/**
 * Background auto-updater for mirrored repositories.
 *
 * - Skips repos whose remote HEAD hasn't moved (no 5-minute re-clone churn).
 * - Runs at most one update cycle at a time (no overlapping clones).
 * - In-place fetch+convert while git data still exists; re-clones after it
 *   has been stripped, preserving local PRs and config.
 */
let running = false;

function startAutoUpdater() {
    // Run every 5 minutes
    setInterval(async () => {
        if (running) {
            console.log('[Repo Updater] Previous cycle still running, skipping.');
            return;
        }
        running = true;
        try {
            const allRepos = await db.repos.all();
            const mirroredRepos = allRepos.filter(r => r.value && r.value.importedFrom);

            console.log(`[Repo Updater] Starting background update for ${mirroredRepos.length} mirrored repositories...`);

            for (let i = 0; i < mirroredRepos.length; i++) {
                const repo = mirroredRepos[i].value;
                try {
                    await updateMirroredRepo(repo);
                } catch (e) {
                    console.error(`[Repo Updater] Update failed for ${repo.owner}/${repo.name}: ${e.message}`);
                }

                if (i < mirroredRepos.length - 1) {
                    const delay = Math.floor(Math.random() * 2000) + 3000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            console.log(`[Repo Updater] Background update completed.`);
        } catch (err) {
            console.error('[Repo Updater] Error during background update:', err.message);
        } finally {
            running = false;
        }
    }, 5 * 60 * 1000);
}

async function updateMirroredRepo(repo) {
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), repo.owner, repo.name);
    if (!repoPath || !fs.existsSync(repoPath)) return;

    const bruvRepo = new BruvRepo(repoPath);
    const remotes = bruvRepo.listRemotes();
    const remoteUrl = remotes.origin || repo.importedFrom;
    if (!remoteUrl) return;

    // Cheap remote probe — skip everything when nothing changed upstream
    let remoteHead = null;
    try {
        remoteHead = execSync(`git ls-remote ${remoteUrl} HEAD`, { stdio: 'pipe' }).toString().split('\t')[0].trim() || null;
    } catch (e) {
        console.error(`[Repo Updater] ls-remote failed for ${remoteUrl}: ${e.message}`);
        return;
    }
    const lastSync = readJson(path.join(repoPath, '.bruv', 'last-sync.json'), {});
    if (remoteHead && lastSync.remoteHead === remoteHead) return;

    console.log(`[Repo Updater] Updating ${repo.owner}/${repo.name}...`);

    if (gitToBruv.isBareGitRepo(repoPath)) {
        // Git data still present — fetch and convert in place
        let before = null;
        try { before = execSync('git rev-parse --all', { cwd: repoPath, stdio: 'pipe' }).toString(); } catch (e) {}
        try {
            execSync('git fetch --all --prune', { cwd: repoPath, stdio: 'pipe' });
        } catch (e) {
            console.error(`[Repo Updater] fetch failed for ${repo.owner}/${repo.name}: ${e.message}`);
            return;
        }
        const after = (() => {
            try { return execSync('git rev-parse --all', { cwd: repoPath, stdio: 'pipe' }).toString(); } catch (e) { return null; }
        })();
        if (before && before === after) {
            writeJson(path.join(repoPath, '.bruv', 'last-sync.json'), { remoteHead, at: new Date().toISOString() });
            return;
        }
        await gitToBruv.convertGitToBruv(repoPath, {
            force: true,
            isPrivate: repo.isPrivate || false,
            author: repo.owner,
        });
        console.log(`[Repo Updater] Updated ${repo.owner}/${repo.name} in place`);
    } else {
        // Git data stripped — re-clone from origin into a temp dir, then swap
        const tmpPath = repoPath + '.update-tmp';
        try {
            await gitToBruv.cloneAndConvert(remoteUrl, tmpPath, {
                isPrivate: repo.isPrivate || false,
                author: repo.owner,
            });
            preserveLocalState(repoPath, tmpPath);
            fs.rmSync(repoPath, { recursive: true, force: true });
            fs.renameSync(tmpPath, repoPath);
            console.log(`[Repo Updater] Re-cloned ${repo.owner}/${repo.name}`);
        } catch (e) {
            console.error(`[Repo Updater] bruv update failed for ${repo.owner}/${repo.name}: ${e.message}`);
            if (fs.existsSync(tmpPath)) {
                fs.rmSync(tmpPath, { recursive: true, force: true });
            }
            return;
        }
    }

    writeJson(path.join(repoPath, '.bruv', 'last-sync.json'), { remoteHead, at: new Date().toISOString() });
}

// Local-only state survives re-clones (PR refs, privacy, repo config)
function preserveLocalState(oldPath, newPath) {
    for (const item of ['refs/prs', 'config.json', 'privacy.json']) {
        const src = path.join(oldPath, '.bruv', item);
        const dest = path.join(newPath, '.bruv', item);
        if (fs.existsSync(src)) {
            fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(src, dest, { recursive: true });
        }
    }
}

module.exports = { startAutoUpdater };

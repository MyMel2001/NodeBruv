const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const gitToBruv = require('./git-to-bruv');

// Import bruv library directly for bruv-native operations
const BruvRepo = require('../../bruv/src/core/repo');
const BruvObjects = require('../../bruv/src/core/objects');

/**
 * Scans a repository for outdated dependencies in package.json.
 * Uses bruv's checkoutBruvToDir() to get files, then uses bruv to commit updates.
 * Git is used only for legacy bare git repo fallback.
 * @param {string} repoPath
 */
async function scan(repoPath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-dep-scan-'));

    try {
        if (gitToBruv.isBruvRepo(repoPath)) {
            // Use bruv checkout — no git needed
            try {
                gitToBruv.checkoutBruvToDir(repoPath, tempDir);
            } catch (e) {
                console.error(`[DEP SCAN] bruv checkout failed: ${e.message}`);
                return cleanup(tempDir);
            }
        } else {
            // Legacy git bare repo fallback — git clone is required here
            try {
                execSync(`git clone ${repoPath} ${tempDir}`);
            } catch (e) {
                console.error(`[DEP SCAN] git clone failed: ${e.message}`);
                return cleanup(tempDir);
            }
        }

        const pkgPath = path.join(tempDir, 'package.json');
        if (!fs.existsSync(pkgPath)) return cleanup(tempDir);

        console.log(`[DEP SCAN] Scanning ${repoPath}...`);

        try {
            const outdatedJson = execSync(`npm outdated --json`, { cwd: tempDir }).toString();
            const outdated = JSON.parse(outdatedJson || '{}');

            let updated = false;
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

            for (const [name, info] of Object.entries(outdated)) {
                if (info.current !== info.latest && info.latest.split('.')[0] === info.current.split('.')[0]) {
                    console.log(`[DEP SCAN] Updating ${name} to ${info.latest}`);
                    execSync(`npm install ${name}@${info.latest} --save`, { cwd: tempDir });
                    updated = true;
                }
            }

            if (updated && gitToBruv.isBruvRepo(repoPath)) {
                // Commit updated package.json via bruv (no git needed)
                const repo = new BruvRepo(repoPath);
                const filesToAdd = ['package.json', 'package-lock.json'].filter(f =>
                    fs.existsSync(path.join(tempDir, f))
                );

                // Write updated files back into bruv object store
                const objects = new BruvObjects(repoPath);
                const head = objects.resolveHead();
                if (head && head.commit && head.commit.tree) {
                    // Stage the updated files from tempDir into bruv
                    for (const file of filesToAdd) {
                        const srcPath = path.join(tempDir, file);
                        if (fs.existsSync(srcPath)) {
                            // Copy updated file into repo working dir for bruv add
                            const destPath = path.join(repoPath, file);
                            fs.copyFileSync(srcPath, destPath);
                        }
                    }
                    repo.add(filesToAdd.map(f => path.join(repoPath, f)));
                    repo.commit('chore: automatic dependency updates', { author: 'dep-scanner' });
                    console.log(`[DEP SCAN] Committed updates to bruv repo at ${repoPath}`);
                }
            } else if (updated) {
                // Legacy git path
                execSync(`git add package.json package-lock.json`, { cwd: tempDir });
                execSync(`git commit -m "chore: automatic dependency updates"`, { cwd: tempDir });
                execSync(`git push origin main`, { cwd: tempDir });
                console.log(`[DEP SCAN] Pushed updates to ${repoPath}`);
            }

        } catch (err) {
            if (!err.stdout) {
                console.error(`[DEP SCAN] Error during scan:`, err.message);
            }
        }

    } catch (e) {
        console.error(`[DEP SCAN] Failed to scan:`, e.message);
    } finally {
        cleanup(tempDir);
    }
}

function cleanup(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { scan };

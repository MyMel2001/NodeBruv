const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');
const gitToBruv = require('./git-to-bruv');

/**
 * Scans a repository for outdated dependencies in package.json
 * Works with both bruv repos and legacy git bare repos.
 * @param {string} repoPath 
 */
function scan(repoPath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-dep-scan-'));
    
    try {
        // Clone into temp dir
        if (gitToBruv.isBruvRepo(repoPath)) {
            const gitBarePath = repoPath.replace(/\.bruv$/, '.git');
            if (fs.existsSync(gitBarePath)) {
                execSync(`git clone ${gitBarePath} ${tempDir}`);
            } else {
                return cleanup(tempDir);
            }
        } else {
            execSync(`git clone ${repoPath} ${tempDir}`);
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

            if (updated) {
                execSync(`git add package.json package-lock.json`, { cwd: tempDir });
                execSync(`git commit -m "chore: automatic dependency updates"`, { cwd: tempDir });
                execSync(`git push origin main`, { cwd: tempDir });
                console.log(`[DEP SCAN] Pushed updates to ${repoPath}`);
                
                // Auto-convert to bruv after update
                const bruvDir = path.join(repoPath, '.bruv');
                if (!fs.existsSync(bruvDir)) {
                    try { gitToBruv.convertGitToBruv(repoPath); } catch (e) {}
                }
            }

        } catch (err) {
            if (err.stdout) {
                // Handle json output even on exit 1
            } else {
                console.error(`[DEP SCAN] Error during scan:`, err.message);
            }
        }

    } catch (e) {
        console.error(`[DEP SCAN] Failed to clone or scan:`, e.message);
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

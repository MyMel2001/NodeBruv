const fs = require('fs');
const { execSync } = require('child_process');

// Regex patterns for secrets
const SECRET_PATTERNS = [
    /(password|passwd|pwd|secret|key|token)[\s=:]+['"]?[A-Za-z0-9\-_]{8,}['"]?/i,
    /sk-[a-zA-Z0-9]{20,}/, // OpenAI style keys
    /AKIA[0-9A-Z]{16}/,    // AWS keys
    /gh[pousr]_[A-Za-z0-9_]{36,}/ // GitHub tokens
];

const BLOCKED_FILES = ['.env', 'credentials.json', 'id_rsa', 'id_dsa'];

function runPreReceive() {
    // Read from stdin (oldrev newrev refname)
    const stdinBuffer = fs.readFileSync(0);
    const lines = stdinBuffer.toString().split('\n').filter(Boolean);

    for (const line of lines) {
        const [oldRev, newRev, refName] = line.split(' ');
        
        // If it's a new branch, oldRev will be all 0s
        const revRange = /^0+$/.test(oldRev) ? newRev : `${oldRev}..${newRev}`;

        try {
            // Get list of all new commits
            const commits = execSync(`git rev-list ${revRange}`).toString().split('\n').filter(Boolean);

            for (const commit of commits) {
                // Get changed files in the commit
                const changes = execSync(`git diff-tree --no-commit-id --name-status -r ${commit}`).toString().split('\n').filter(Boolean);
                
                for (const change of changes) {
                    const [status, filename] = change.split('\t');
                    if (status === 'D') continue; // Deleted file, ignore

                    // Check file names
                    if (BLOCKED_FILES.some(f => filename.endsWith(f))) {
                        console.error(`\x1b[31m[REJECTED]\x1b[0m File "${filename}" is blocked (potential secret file).`);
                        process.exit(1);
                    }

                    // Check file content
                    let size = 0;
                    try {
                        size = parseInt(execSync(`git cat-file -s ${commit}:${filename}`).toString().trim(), 10);
                    } catch (err) {
                        // ignore or handle
                    }
                    if (size > 5 * 1024 * 1024) {
                        continue; // Skip files > 5MB
                    }

                    let contentBuffer;
                    try {
                        contentBuffer = execSync(`git show ${commit}:${filename}`, { maxBuffer: 6 * 1024 * 1024 });
                    } catch (err) {
                        continue;
                    }

                    // Check for null bytes in the first 8KB to detect binary
                    const checkLength = Math.min(contentBuffer.length, 8192);
                    let isBinary = false;
                    for (let i = 0; i < checkLength; i++) {
                        if (contentBuffer[i] === 0) {
                            isBinary = true;
                            break;
                        }
                    }
                    if (isBinary) {
                        continue; // Skip binary files
                    }

                    let contentStr = contentBuffer.toString('utf8');
                    // Remove ${{ ... }} and ${ ... } placeholders
                    contentStr = contentStr.replace(/\$\{\{[\s\S]*?\}\}/g, '');
                    contentStr = contentStr.replace(/\$\{[\s\S]*?\}/g, '');

                    for (const pattern of SECRET_PATTERNS) {
                        if (pattern.test(contentStr)) {
                            console.error(`\x1b[31m[REJECTED]\x1b[0m Push contains potential secrets in file "${filename}" at commit ${commit.substring(0, 7)}.`);
                            process.exit(1);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Error scanning commits for secrets:', err.message);
            // Block push on scanner failure for security, or let it pass? We'll let it fail.
            process.exit(1);
        }
    }
    
    // All checks passed
    process.exit(0);
}

module.exports = {
    runPreReceive
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('yaml');
const { spawn } = require('child_process');
const gitToBruv = require('./git-to-bruv');

/**
 * Runs a simple CI/CD stub based on .bruv-ci.yml or .github/workflows/*.yml.
 * Uses bruv's checkoutBruvToDir() to prepare the working directory.
 * Git is only used when falling back to a legacy bare git repo.
 * @param {string} repoPath Path to the repository
 */
function run(repoPath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-ci-'));

    try {
        if (gitToBruv.isBruvRepo(repoPath)) {
            // Use bruv's checkout to extract files into the temp dir
            try {
                gitToBruv.checkoutBruvToDir(repoPath, tempDir);
                processWorkflows(0);
            } catch (e) {
                console.error(`[CI] bruv checkout failed for ${repoPath}: ${e.message}`);
                cleanup(tempDir);
            }
            return;
        }

        // Legacy git bare repo fallback — git clone is required here
        spawn('git', ['clone', repoPath, tempDir]).on('close', processWorkflows);
    } catch (e) {
        console.error('CI Runner error:', e);
    }

    function processWorkflows(code) {
        if (code !== 0) return cleanup(tempDir);

        const workflowsDir = path.join(tempDir, '.github', 'workflows');
        if (!fs.existsSync(workflowsDir)) return cleanup(tempDir);

        const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

        files.forEach(file => {
            const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
            try {
                const parsed = yaml.parse(content);
                if (parsed && parsed.jobs) {
                    for (const [jobId, job] of Object.entries(parsed.jobs)) {
                        const image = mapRunsOnToImage(job['runs-on']);

                        if (job.steps) {
                            console.log(`[CI] Starting job ${jobId} in Docker container (${image})`);

                            let shellScript = 'set -e\n\n';

                            if (job.env) {
                                for (const [k, v] of Object.entries(job.env)) {
                                    shellScript += `export ${k}='${escapeShellArg(v)}'\n`;
                                }
                                shellScript += '\n';
                            }

                            for (let i = 0; i < job.steps.length; i++) {
                                const s = job.steps[i];
                                const stepName = s.name || `Step ${i + 1}`;
                                shellScript += `echo "::group::${stepName}"\n`;

                                if (s.uses) {
                                    if (s.uses.startsWith('actions/checkout')) {
                                        shellScript += `echo "Skipping actions/checkout since repo is already checked out."\n`;
                                    } else {
                                        shellScript += `echo "Warning: GitHub Action '${s.uses}' is not natively supported in this runner."\n`;
                                    }
                                } else if (s.run) {
                                    shellScript += `(\n`;

                                    if (s.env) {
                                        for (const [k, v] of Object.entries(s.env)) {
                                            shellScript += `export ${k}='${escapeShellArg(v)}'\n`;
                                        }
                                    }

                                    if (s['working-directory']) {
                                        shellScript += `cd "${s['working-directory']}"\n`;
                                    }

                                    shellScript += `${substituteContext(s.run)}\n)\n`;
                                }
                                shellScript += `echo "::endgroup::"\n\n`;
                            }

                            const scriptPath = path.join(tempDir, `.ci_script_${jobId}.sh`);
                            fs.writeFileSync(scriptPath, shellScript);

                            const docker = spawn('docker', [
                                'run', '--rm',
                                '-e', 'GITHUB_WORKSPACE=/workspace',
                                '-v', `${tempDir}:/workspace`,
                                '-w', '/workspace',
                                image,
                                'sh', `.ci_script_${jobId}.sh`
                            ]);

                            docker.stdout.on('data', d => process.stdout.write(`[CI][${jobId}] ${d}`));
                            docker.stderr.on('data', d => process.stderr.write(`[CI][${jobId}] ERR: ${d}`));
                            docker.on('close', code => {
                                console.log(`[CI][${jobId}] Finished with code ${code}`);
                                cleanup(tempDir);
                            });
                        }
                    }
                }
            } catch (e) {
                console.error(`[CI] Error parsing workflow ${file}:`, e);
            }
        });
    }
}

function mapRunsOnToImage(runsOn) {
    if (!runsOn) return 'node:20-slim';
    if (runsOn.includes('ubuntu')) return 'ubuntu:latest';
    return 'node:20-slim';
}

function escapeShellArg(arg) {
    if (arg === null || arg === undefined) return '';
    return String(arg).replace(/'/g, "'\\''");
}

function substituteContext(str) {
    if (!str) return '';
    return str.replace(/\$\{\{\s*github\.workspace\s*\}\}/g, '/workspace');
}

function cleanup(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { run };

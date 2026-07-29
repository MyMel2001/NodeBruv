/**
 * Git-to-Bruv converter service.
 *
 * Converts existing bare git repos to bruv repos on the server, and handles
 * all new bruv repo initialization. Uses the actual bruv library from
 * ../../bruv/src instead of custom stub implementations.
 *
 * bruv stores repos as working directories with a .bruv/ subdirectory.
 * For server-side hosting (bare-like), we store the .bruv/ content in
 * repos/owner/repo.bruv/ — using .bruv suffix to distinguish from old .git bare repos.
 *
 * NOTE: Git is only used where explicitly required:
 *   - cloneAndConvert: clones from GitHub/Git remotes, then converts to bruv
 *   - autoConvertExisting: detects legacy bare git repos and converts them
 *   - resolveRepoPath: auto-converts legacy git repos on first access
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Import bruv library directly
const BruvRepo = require('../../bruv/src/core/repo');
const BruvObjects = require('../../bruv/src/core/objects');
const { shortHash } = require('../../bruv/src/utils/hash');
const { ensureDir, readJson, writeJson } = require('../../bruv/src/utils/fs');

// Re-export for convenience (used in routes)
module.exports.shortHash = shortHash;
module.exports.ensureDir = ensureDir;
module.exports.readJson = readJson;
module.exports.writeJson = writeJson;

/**
 * Check if a directory is a bare git repo (has HEAD, objects/, refs/).
 */
function isBareGitRepo(repoPath) {
    return fs.existsSync(path.join(repoPath, 'HEAD')) &&
        fs.existsSync(path.join(repoPath, 'objects')) &&
        fs.existsSync(path.join(repoPath, 'refs')) &&
        !fs.existsSync(path.join(repoPath, '.git')); // bare repos don't have .git
}

/**
 * Check if a directory is already a bruv repo (has .bruv/).
 */
function isBruvRepo(repoPath) {
    return fs.existsSync(path.join(repoPath, '.bruv'));
}

/**
 * Write a bruv object to the object store.
 * Delegates to BruvObjects.writeObject() from the bruv library.
 */
function writeBruvObject(bruvDir, type, content) {
    // bruvDir is the .bruv/ directory; BruvObjects expects the repo root
    const repoPath = path.basename(bruvDir) === '.bruv' ? path.dirname(bruvDir) : bruvDir;
    const objects = new BruvObjects(repoPath);
    return objects.writeObject(type, content);
}

/**
 * Write a bruv tree from a map of files (path -> blobHash).
 * Delegates to BruvObjects.writeTree().
 */
function writeBruvTree(bruvDir, fileMap) {
    const repoPath = path.basename(bruvDir) === '.bruv' ? path.dirname(bruvDir) : bruvDir;
    const objects = new BruvObjects(repoPath);

    // Build entry list for the tree, then delegate recursive build
    // We use the repo helper to build the tree from the flat file map
    const repo = new BruvRepo(repoPath);
    return repo._buildTreeFromFileMap(fileMap);
}

/**
 * Spawn `git cat-file -p <hash>` with streaming to avoid ENOBUFS on large blobs.
 */
function spawnGitCatFile(gitHash, cwd) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const proc = spawn('git', ['cat-file', '-p', gitHash], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.on('close', code => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`git cat-file -p ${shortHash(gitHash)} exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

/**
 * Spawn `git cat-file -t <hash>` to get the type of a git object.
 */
function spawnGitCatFileType(gitHash, cwd) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const proc = spawn('git', ['cat-file', '-t', gitHash], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.on('close', code => {
            if (code === 0) resolve(Buffer.concat(chunks).toString().trim());
            else reject(new Error(`git cat-file -t ${shortHash(gitHash)} exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

/**
 * Convert a git tree entry to a bruv tree, recursively.
 * Uses BruvObjects from the bruv library to write blobs and trees.
 */
async function convertGitTree(gitTreeHash, objects, bareGitPath) {
    try {
        const lsTree = execSync(`git ls-tree ${gitTreeHash}`, {
            cwd: bareGitPath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024
        }).toString();
        const entries = lsTree.split('\n').filter(Boolean).map(line => {
            const parts = line.split(/\s+/);
            return { mode: parts[0], type: parts[1], objectHash: parts[2], name: parts.slice(3).join(' ') };
        });

        const bruvEntries = [];
        for (const entry of entries) {
            if (entry.type === 'blob') {
                try {
                    const content = await spawnGitCatFile(entry.objectHash, bareGitPath);
                    const bruvBlobHash = objects.writeBlob(content);
                    bruvEntries.push({ name: entry.name, type: 'blob', hash: bruvBlobHash });
                } catch (e) {
                    console.error(`[git-to-bruv] Skipping blob ${shortHash(entry.objectHash)} (${entry.name}): ${e.message}`);
                }
            } else if (entry.type === 'tree') {
                const subTreeHash = await convertGitTree(entry.objectHash, objects, bareGitPath);
                if (subTreeHash) {
                    bruvEntries.push({ name: entry.name, type: 'tree', hash: subTreeHash });
                }
            }
        }

        bruvEntries.sort((a, b) => a.name.localeCompare(b.name));
        return objects.writeTree(bruvEntries);
    } catch (e) {
        console.error(`[git-to-bruv] Failed to convert tree ${shortHash(gitTreeHash)}: ${e.message}`);
        return objects.writeTree([]); // empty tree fallback
    }
}

/**
 * Convert a bare git repo to a bruv repo.
 * Uses bruv library (BruvObjects) for all object writing.
 *
 * Strategy:
 * 1. Read all git commits and their trees via `git cat-file`
 * 2. Convert all blobs to bruv format using BruvObjects
 * 3. Reconstruct trees and commits in bruv format
 * 4. Map git branches → bruv snapshots
 * 5. Create HEAD pointing to the main/default snapshot
 */
async function convertGitToBruv(bareGitPath, options = {}) {
    if (isBruvRepo(bareGitPath)) {
        return { status: 'already-bruv', path: bareGitPath };
    }

    if (!isBareGitRepo(bareGitPath)) {
        throw new Error(`Not a bare git repo: ${bareGitPath}`);
    }

    console.log(`[git-to-bruv] Converting ${bareGitPath} to bruv...`);

    // BruvObjects operates on the repo root (bareGitPath), writing to bareGitPath/.bruv/
    const objects = new BruvObjects(bareGitPath);
    const bruvDir = path.join(bareGitPath, '.bruv');

    // Ensure bruv directory structure
    ensureDir(bruvDir);
    ensureDir(path.join(bruvDir, 'objects'));
    ensureDir(path.join(bruvDir, 'refs', 'tags'));
    ensureDir(path.join(bruvDir, 'refs', 'snapshots'));
    ensureDir(path.join(bruvDir, 'refs', 'prs'));

    // Write repo config
    writeJson(path.join(bruvDir, 'config.json'), {
        isPrivate: options.isPrivate || false,
        defaultRemote: options.remote || null,
        created: options.created || new Date().toISOString(),
        convertedFromGit: true,
        convertedAt: new Date().toISOString(),
    });

    // Get all branches
    let branches = [];
    try {
        const branchOutput = execSync(`git branch --format='%(refname:short)'`, { cwd: bareGitPath }).toString();
        branches = branchOutput.split('\n').filter(Boolean);
    } catch (e) {
        branches = ['main'];
    }

    // Get all tags
    let tags = [];
    try {
        const tagOutput = execSync(`git tag -l`, { cwd: bareGitPath }).toString();
        tags = tagOutput.split('\n').filter(Boolean);
    } catch (e) {
        tags = [];
    }

    // Get HEAD reference
    let headRef = 'main';
    try {
        const headContent = fs.readFileSync(path.join(bareGitPath, 'HEAD'), 'utf8').trim();
        if (headContent.startsWith('ref:')) {
            headRef = headContent.replace('ref: refs/heads/', '').trim();
        }
    } catch (e) {
        headRef = branches[0] || 'main';
    }

    // Map: git tree hash -> bruv tree hash
    const treeHashMap = new Map();
    // Map: git commit hash -> bruv commit hash
    const commitHashMap = new Map();

    // Collect all commit hashes across branches + tags
    const allCommitHashes = new Set();
    for (const branch of branches) {
        try {
            const revList = execSync(`git rev-list ${branch}`, { cwd: bareGitPath, stdio: 'pipe' }).toString();
            revList.split('\n').filter(Boolean).forEach(c => allCommitHashes.add(c));
        } catch (e) {}
    }
    for (const tag of tags) {
        try {
            const ref = execSync(`git rev-parse ${tag}^{}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            allCommitHashes.add(ref);
        } catch (e) {}
    }

    const author = options.author || 'bruv-converter';

    // Convert a single git commit to bruv using BruvObjects
    async function convertCommit(gitHash) {
        if (commitHashMap.has(gitHash)) return commitHashMap.get(gitHash);
        try {
            const gitTreeHash = execSync(`git rev-parse ${gitHash}^{tree}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const parentsLine = execSync(`git rev-list --parents -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const parentHashes = parentsLine.split(' ').filter(h => h !== gitHash);

            const commitMsg = execSync(`git log --format=%B -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const authorName = execSync(`git log --format=%an -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const authorEmail = execSync(`git log --format=%ae -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const timestamp = execSync(`git log --format=%aI -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();

            // Convert tree
            if (!treeHashMap.has(gitTreeHash)) {
                const bruvTreeHash = await convertGitTree(gitTreeHash, objects, bareGitPath);
                treeHashMap.set(gitTreeHash, bruvTreeHash);
            }
            const bruvTreeHash = treeHashMap.get(gitTreeHash);

            // Convert parent commits first (recursive)
            const bruvParents = [];
            for (const ph of parentHashes) {
                const converted = await convertCommit(ph);
                if (converted) bruvParents.push(converted);
            }

            // Write bruv commit using BruvObjects
            const bruvCommitHash = objects.writeCommit({
                tree: bruvTreeHash,
                parents: bruvParents,
                message: commitMsg,
                author: authorEmail ? `${authorName} <${authorEmail}>` : authorName,
                timestamp,
                metadata: { importedFromGit: gitHash },
            });

            commitHashMap.set(gitHash, bruvCommitHash);
            return bruvCommitHash;
        } catch (e) {
            console.error(`[git-to-bruv] Failed to convert commit ${shortHash(gitHash)}: ${e.message}`);
            return null;
        }
    }

    console.log(`[git-to-bruv] Converting ${allCommitHashes.size} commits...`);
    for (const gitHash of allCommitHashes) {
        await convertCommit(gitHash);
    }

    // Convert branches to bruv snapshots using BruvObjects.writeSnapshot()
    console.log(`[git-to-bruv] Converting ${branches.length} branches to snapshots...`);
    for (const branch of branches) {
        try {
            const gitCommitHash = execSync(`git rev-parse ${branch}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const bruvCommitHash = commitHashMap.get(gitCommitHash);
            if (bruvCommitHash) {
                objects.writeSnapshot({
                    name: branch,
                    commit: bruvCommitHash,
                    message: `Imported from git branch '${branch}'`,
                    author,
                    parent: null,
                    metadata: { importedFromGit: gitCommitHash, branch },
                });
            }
        } catch (e) {}
    }

    // Convert tags using BruvObjects.writeTag()
    console.log(`[git-to-bruv] Converting ${tags.length} tags...`);
    for (const tag of tags) {
        try {
            const gitCommitHash = execSync(`git rev-parse ${tag}^{}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
            const bruvCommitHash = commitHashMap.get(gitCommitHash);
            if (bruvCommitHash) {
                objects.writeTag({
                    name: tag,
                    commit: bruvCommitHash,
                    message: `Imported from git tag '${tag}'`,
                    author,
                    metadata: { importedFromGit: gitCommitHash },
                });
            }
        } catch (e) {}
    }

    // Set HEAD using BruvObjects.setHead()
    const mainSnapshot = branches.includes('main') ? 'main' : (branches.includes('master') ? 'master' : (branches[0] || 'main'));
    objects.setHead('snapshot', mainSnapshot);

    // Write .bruvignore if not present
    const ignorePath = path.join(bareGitPath, '.bruvignore');
    if (!fs.existsSync(ignorePath)) {
        fs.writeFileSync(ignorePath, [
            'node_modules/', '.env', '.env.*', '*.pem', '*.key',
            'credentials.json', 'secrets.yml', '.DS_Store',
            'dist/', 'build/', '.next/', '.bruv/', '.git/',
        ].join('\n') + '\n', 'utf8');
    }

    console.log(`[git-to-bruv] Successfully converted ${bareGitPath}`);
    return { status: 'converted', path: bareGitPath, snapshots: branches.length, commits: allCommitHashes.size };
}

/**
 * Clone a remote git repo (e.g., from GitHub) and convert it to bruv.
 * This is the primary path for GitHub imports.
 * Git clone is used here intentionally to clone from remote Git/GitHub URLs.
 */
function cloneAndConvert(cloneUrl, destPath, options = {}) {
    return new Promise((resolve, reject) => {
        console.log(`[git-to-bruv] Cloning ${cloneUrl}...`);

        const tmpDir = path.join(path.dirname(destPath), '.tmp-' + path.basename(destPath));

        // Clone as mirror (bare) into temp dir — git clone is required here for GitHub/Git URLs
        const git = spawn('git', ['clone', '--mirror', cloneUrl, tmpDir]);

        let stderr = '';
        git.stderr.on('data', d => { stderr += d.toString(); });

        git.on('close', async code => {
            if (code !== 0) {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
                return reject(new Error(`Git clone failed (code ${code}): ${stderr}`));
            }

            try {
                // Convert the bare git clone to bruv using bruv library
                const result = await convertGitToBruv(tmpDir, options);

                // Move to final destination
                if (fs.existsSync(destPath)) {
                    fs.rmSync(destPath, { recursive: true, force: true });
                }
                ensureDir(path.dirname(destPath));
                fs.renameSync(tmpDir, destPath);

                resolve(result);
            } catch (e) {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
                reject(e);
            }
        });

        git.on('error', err => {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
            reject(err);
        });
    });
}

/**
 * Create a fresh bruv repo from scratch using BruvRepo.init() from the bruv library.
 */
function createNewBruvRepo(repoPath, options = {}) {
    if (isBruvRepo(repoPath)) {
        return { status: 'already-bruv', path: repoPath };
    }

    ensureDir(repoPath);

    try {
        BruvRepo.init(repoPath, {
            private: options.isPrivate || false,
            remote: options.remote || null,
            author: options.author || 'bruv-frontend',
            email: options.email || '',
            message: options.message || 'Initial commit',
        });
    } catch (e) {
        if (e.message && e.message.includes('already initialized')) {
            return { status: 'already-bruv', path: repoPath };
        }
        throw e;
    }

    return { status: 'created', path: repoPath };
}

/**
 * Checkout bruv repo files to a target directory.
 * Uses BruvObjects.checkoutTree() from the bruv library.
 */
function checkoutBruvToDir(repoPath, destDir) {
    const objects = new BruvObjects(repoPath);
    const head = objects.resolveHead();
    if (!head || !head.commit || !head.commit.tree) {
        throw new Error(`No HEAD or empty tree in bruv repo at ${repoPath}`);
    }
    ensureDir(destDir);
    objects.checkoutTree(head.commit.tree, destDir);
    return destDir;
}

/**
 * Scan for existing bare git repos and auto-convert them to bruv.
 * Called at server startup.
 */
async function autoConvertExisting(reposDir) {
    if (!fs.existsSync(reposDir)) return { converted: 0, skipped: 0 };

    let converted = 0;
    let skipped = 0;

    async function walk(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.endsWith('.git')) {
                    if (!isBruvRepo(full)) {
                        try {
                            await convertGitToBruv(full);
                            converted++;
                        } catch (e) {
                            console.error(`[git-to-bruv] Failed to convert ${full}: ${e.message}`);
                            skipped++;
                        }
                    } else {
                        skipped++;
                    }
                } else if (entry.name.endsWith('.bruv')) {
                    skipped++;
                } else {
                    await walk(full);
                }
            }
        }
    }

    await walk(reposDir);
    return { converted, skipped };
}

/**
 * Resolve repository path regardless of storage format.
 * Returns the repo root directory (where .bruv/ lives).
 */
async function resolveRepoPath(reposBaseDir, owner, repoName) {
    // Try .bruv first (bruv-native)
    const bruvPath = path.join(reposBaseDir, owner, repoName + '.bruv');
    if (fs.existsSync(bruvPath) && isBruvRepo(bruvPath)) {
        return bruvPath;
    }

    // Try .git (old bare git repo — auto-convert)
    const gitPath = path.join(reposBaseDir, owner, repoName + '.git');
    if (fs.existsSync(gitPath) && isBareGitRepo(gitPath)) {
        console.log(`[git-to-bruv] Auto-converting legacy git repo: ${owner}/${repoName}`);
        try {
            await convertGitToBruv(gitPath);
            return gitPath; // Now has .bruv/ too
        } catch (e) {
            console.error(`[git-to-bruv] Auto-conversion failed: ${e.message}`);
            return null;
        }
    }

    return null;
}

module.exports = {
    isBareGitRepo,
    isBruvRepo,
    convertGitToBruv,
    cloneAndConvert,
    createNewBruvRepo,
    checkoutBruvToDir,
    autoConvertExisting,
    resolveRepoPath,
    // Legacy helpers re-exported from bruv library
    writeBruvObject,
    writeBruvTree,
    shortHash,
    ensureDir,
    writeJson,
    readJson,
};

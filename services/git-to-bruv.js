/**
 * Git-to-Bruv converter service.
 * 
 * Converts existing bare git repos to bruv repos on the server.
 * Called automatically when:
 * - A git bare repo is detected at startup (auto-migration)
 * - A GitHub repo is imported via clone
 * - A new repo is created (creates bruv from scratch)
 *
 * bruv stores repos as working directories with a .bruv/ subdirectory.
 * For server-side hosting (bare-like), we store the .bruv/ content in
 * repos/owner/repo.bruv/ — using .bruv suffix to distinguish from old .git bare repos.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

// bruv-compatible object hashing (SHA-256, same as bruv uses)
function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shortHash(fullHash) {
  return fullHash.slice(0, 7);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(filePath, defaultValue = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

/**
 * Check if a directory is a bare git repo (has HEAD, objects/, refs/)
 */
function isBareGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, 'HEAD')) &&
         fs.existsSync(path.join(repoPath, 'objects')) &&
         fs.existsSync(path.join(repoPath, 'refs')) &&
         !fs.existsSync(path.join(repoPath, '.git')); // bare repos don't have .git
}

/**
 * Check if a directory is already a bruv repo
 */
function isBruvRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, '.bruv'));
}

/**
 * Write a bruv object (content-addressable, SHA-256)
 */
function writeBruvObject(bruvDir, type, content) {
  const header = `${type}\0`;
  const buf = Buffer.concat([Buffer.from(header, 'utf8'), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')]);
  const hash = hashBuffer(buf);
  const objPath = path.join(bruvDir, 'objects', hash.slice(0, 2), hash.slice(2));
  if (!fs.existsSync(objPath)) {
    ensureDir(path.dirname(objPath));
    fs.writeFileSync(objPath, buf);
  }
  return hash;
}

/**
 * Write a bruv tree from a map of files (path -> blobHash)
 * Replicates _buildTreeFromFileMap from bruv/src/core/repo.js
 */
function writeBruvTree(bruvDir, fileMap) {
  const dirMap = new Map();

  for (const [filePath, hash] of Object.entries(fileMap)) {
    const parts = filePath.split('/');
    const fileName = parts.pop();
    const dirKey = parts.join('/');
    if (!dirMap.has(dirKey)) dirMap.set(dirKey, []);
    dirMap.get(dirKey).push({ name: fileName, type: 'blob', hash });
  }

  return _buildTreeRecursive(bruvDir, '', dirMap);
}

function _buildTreeRecursive(bruvDir, dirPath, dirMap) {
  const entries = dirMap.get(dirPath) || [];
  const subDirs = new Set();

  for (const [key] of dirMap) {
    if (key === dirPath) continue;
    if (dirPath === '') {
      if (key.includes('/')) subDirs.add(key.split('/')[0]);
    } else if (key.startsWith(dirPath + '/')) {
      const rest = key.slice(dirPath.length + 1);
      if (rest.includes('/')) subDirs.add(rest.split('/')[0]);
    }
  }

  for (const subDir of subDirs) {
    const subDirPath = dirPath ? `${dirPath}/${subDir}` : subDir;
    const subTreeHash = _buildTreeRecursive(bruvDir, subDirPath, dirMap);
    entries.push({ name: subDir, type: 'tree', hash: subTreeHash });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.map(e => `${e.type} ${e.hash} ${e.name}`).join('\n');
  return writeBruvObject(bruvDir, 'tree', lines);
}

/**
 * Spawn `git cat-file -p <hash>` with streaming to avoid ENOBUFS on large blobs.
 * Returns a Promise that resolves with the full Buffer content.
 */
function spawnGitCatFile(gitHash, cwd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn('git', ['cat-file', '-p', gitHash], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`git cat-file -p ${shortHash(gitHash)} exited with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}

/**
 * Spawn `git cat-file -t <hash>` to get the type of a git object.
 * Returns a Promise that resolves with the type string.
 */
function spawnGitCatFileType(gitHash, cwd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn('git', ['cat-file', '-t', gitHash], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString().trim());
      } else {
        reject(new Error(`git cat-file -t ${shortHash(gitHash)} exited with code ${code}`));
      }
    });
    
    proc.on('error', reject);
  });
}

/**
 * Read all blobs from a git bare repo and write them as bruv blobs.
 * Returns a Map of git-blob-hash -> bruv-blob-hash.
 */
async function convertGitObjectsToBruv(bareGitPath, bruvDir) {
  const gitObjectDir = path.join(bareGitPath, 'objects');
  const blobHashMap = new Map(); // gitHash -> bruvHash

  // Walk all objects in git's object store
  function walkObjects(objDir) {
    if (!fs.existsSync(objDir)) return;
    const entries = fs.readdirSync(objDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(objDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.match(/^[0-9a-f]{2}$/)) {
          walkPackOrLoose(full);
        } else if (entry.name === 'pack') {
          // Pack files are harder to read directly; we use `git cat-file`
        }
      }
    }
  }

  // Read loose objects
  function walkPackOrLoose(twoHexDir) {
    if (!fs.existsSync(twoHexDir)) return;
    const files = fs.readdirSync(twoHexDir);
    for (const file of files) {
      const gitHash = path.basename(twoHexDir) + file;
      // We'll collect promises and await them all
      promises.push(
        (async () => {
          try {
            const type = await spawnGitCatFileType(gitHash, bareGitPath);
            if (type === 'blob') {
              const content = await spawnGitCatFile(gitHash, bareGitPath);
              const bruvHash = writeBruvObject(bruvDir, 'blob', content);
              blobHashMap.set(gitHash, bruvHash);
            }
          } catch (e) {
            // Skip corrupted or unreachable objects
          }
        })()
      );
    }
  }

  const promises = [];
  walkObjects(gitObjectDir);
  await Promise.all(promises);
  return blobHashMap;
}

/**
 * Convert a bare git repo to a bruv repo.
 * The resulting bruv repo is stored at the same path, but with .bruv/ instead of git's structure.
 * 
 * Strategy:
 * 1. Read all git commits and their trees via `git cat-file`
 * 2. Convert all blobs to bruv format
 * 3. Reconstruct trees and commits in bruv format
 * 4. Map git branches → bruv snapshots
 * 5. Create HEAD pointing to the main/default snapshot
 * 6. Keep the git objects around for reference (they can coexist)
 */
async function convertGitToBruv(bareGitPath, options = {}) {
  const bruvDir = path.join(bareGitPath, '.bruv');
  
  if (isBruvRepo(bareGitPath)) {
    return { status: 'already-bruv', path: bareGitPath };
  }

  if (!isBareGitRepo(bareGitPath)) {
    throw new Error(`Not a bare git repo: ${bareGitPath}`);
  }

  console.log(`[git-to-bruv] Converting ${bareGitPath} to bruv...`);

  // Create bruv directory structure
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

  // Process all commits for each branch
  let allCommitHashes = new Set();
  for (const branch of branches) {
    try {
      const revList = execSync(`git rev-list ${branch}`, { cwd: bareGitPath, stdio: 'pipe' }).toString();
      const commits = revList.split('\n').filter(Boolean);
      for (const c of commits) allCommitHashes.add(c);
    } catch (e) {
      // Branch may be empty
    }
  }

  // Also include tag targets
  for (const tag of tags) {
    try {
      const ref = execSync(`git rev-parse ${tag}^{}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      allCommitHashes.add(ref);
    } catch (e) {}
  }

  // Convert commits in topological order (parents before children)
  const processed = new Set();
  const commitQueue = Array.from(allCommitHashes);
  const author = options.author || 'bruv-converter';

  async function convertCommit(gitHash) {
    if (commitHashMap.has(gitHash)) return commitHashMap.get(gitHash);

    // Read git commit
    try {
      const gitTreeHash = execSync(`git rev-parse ${gitHash}^{tree}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const parents = execSync(`git rev-list --parents -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const parentHashes = parents.split(' ').filter(h => h !== gitHash);
      
      const commitMsg = execSync(`git log --format=%B -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const authorName = execSync(`git log --format=%an -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const authorEmail = execSync(`git log --format=%ae -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const timestamp = execSync(`git log --format=%aI -n 1 ${gitHash}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();

      // Convert tree
      if (!treeHashMap.has(gitTreeHash)) {
        const bruvTreeHash = await convertGitTree(gitTreeHash, bruvDir, bareGitPath);
        treeHashMap.set(gitTreeHash, bruvTreeHash);
      }
      const bruvTreeHash = treeHashMap.get(gitTreeHash);

      // Convert parent commits first
      const bruvParents = [];
      for (const ph of parentHashes) {
        const converted = await convertCommit(ph);
        if (converted) bruvParents.push(converted);
      }

      // Write bruv commit
      const commitObj = JSON.stringify({
        tree: bruvTreeHash,
        parents: bruvParents,
        message: commitMsg,
        author: authorEmail ? `${authorName} <${authorEmail}>` : authorName,
        timestamp,
        metadata: { importedFromGit: gitHash },
      });
      const bruvCommitHash = writeBruvObject(bruvDir, 'commit', commitObj);
      commitHashMap.set(gitHash, bruvCommitHash);
      return bruvCommitHash;
    } catch (e) {
      console.error(`[git-to-bruv] Failed to convert commit ${shortHash(gitHash)}: ${e.message}`);
      return null;
    }
  }

  async function convertGitTree(gitTreeHash, bruvDir, bareGitPath) {
    try {
      const lsTree = execSync(`git ls-tree ${gitTreeHash}`, { cwd: bareGitPath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).toString();
      const entries = lsTree.split('\n').filter(Boolean).map(line => {
        // Format: <mode> <type> <object> <name>
        const parts = line.split(/\s+/);
        const mode = parts[0];
        const type = parts[1];
        const objectHash = parts[2];
        const name = parts.slice(3).join(' ');
        return { mode, type, objectHash, name };
      });

      const bruvEntries = [];
      for (const entry of entries) {
        if (entry.type === 'blob') {
          try {
            // Use spawn with streaming to avoid ENOBUFS on large blobs
            const content = await spawnGitCatFile(entry.objectHash, bareGitPath);
            const bruvBlobHash = writeBruvObject(bruvDir, 'blob', content);
            bruvEntries.push({ name: entry.name, type: 'blob', hash: bruvBlobHash });
          } catch (e) {
            console.error(`[git-to-bruv] Skipping blob ${shortHash(entry.objectHash)} (${entry.name}): ${e.message}`);
          }
        } else if (entry.type === 'tree') {
          const subTreeHash = await convertGitTree(entry.objectHash, bruvDir, bareGitPath);
          if (subTreeHash) {
            bruvEntries.push({ name: entry.name, type: 'tree', hash: subTreeHash });
          }
        }
      }

      bruvEntries.sort((a, b) => a.name.localeCompare(b.name));
      const lines = bruvEntries.map(e => `${e.type} ${e.hash} ${e.name}`).join('\n');
      return writeBruvObject(bruvDir, 'tree', lines);
    } catch (e) {
      console.error(`[git-to-bruv] Failed to convert tree ${shortHash(gitTreeHash)}: ${e.message}`);
      // Return empty tree as fallback
      return writeBruvObject(bruvDir, 'tree', '');
    }
  }

  // Convert all commits
  console.log(`[git-to-bruv] Converting ${allCommitHashes.size} commits...`);
  for (const gitHash of allCommitHashes) {
    await convertCommit(gitHash);
  }

  // Convert branches to snapshots
  console.log(`[git-to-bruv] Converting ${branches.length} branches to snapshots...`);
  for (const branch of branches) {
    try {
      const gitCommitHash = execSync(`git rev-parse ${branch}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const bruvCommitHash = commitHashMap.get(gitCommitHash);
      if (bruvCommitHash) {
        // Write snapshot ref
        const snapObj = JSON.stringify({
          name: branch,
          commit: bruvCommitHash,
          message: `Imported from git branch '${branch}'`,
          author,
          parent: null,
          timestamp: new Date().toISOString(),
          metadata: { importedFromGit: gitCommitHash, branch },
        });
        const snapHash = writeBruvObject(bruvDir, 'snapshot', snapObj);
        const refPath = path.join(bruvDir, 'refs', 'snapshots', branch);
        ensureDir(path.dirname(refPath));
        fs.writeFileSync(refPath, bruvCommitHash + '\n' + snapHash, 'utf8');
      }
    } catch (e) {
      // Branch doesn't resolve
    }
  }

  // Convert tags
  console.log(`[git-to-bruv] Converting ${tags.length} tags...`);
  for (const tag of tags) {
    try {
      const gitCommitHash = execSync(`git rev-parse ${tag}^{}`, { cwd: bareGitPath, stdio: 'pipe' }).toString().trim();
      const bruvCommitHash = commitHashMap.get(gitCommitHash);
      if (bruvCommitHash) {
        const tagObj = JSON.stringify({
          name: tag,
          commit: bruvCommitHash,
          message: `Imported from git tag '${tag}'`,
          author,
          timestamp: new Date().toISOString(),
          metadata: { importedFromGit: gitCommitHash },
        });
        const tagHash = writeBruvObject(bruvDir, 'tag', tagObj);
        const refPath = path.join(bruvDir, 'refs', 'tags', tag);
        ensureDir(path.dirname(refPath));
        fs.writeFileSync(refPath, bruvCommitHash + '\n' + tagHash, 'utf8');
      }
    } catch (e) {}
  }

  // Set HEAD
  const headPath = path.join(bruvDir, 'HEAD');
  const mainSnapshot = branches.includes('main') ? 'main' : (branches.includes('master') ? 'master' : (branches[0] || 'main'));
  fs.writeFileSync(headPath, `snapshot: ${mainSnapshot}`, 'utf8');

  // Write .bruvignore
  const ignorePath = path.join(bareGitPath, '.bruvignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, [
      'node_modules/',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'credentials.json',
      'secrets.yml',
      '.DS_Store',
      'dist/',
      'build/',
      '.next/',
      '.bruv/',
      '.git/',
    ].join('\n') + '\n', 'utf8');
  }

  console.log(`[git-to-bruv] Successfully converted ${bareGitPath}`);
  return { status: 'converted', path: bareGitPath, snapshots: branches.length, commits: allCommitHashes.size };
}

/**
 * Clone a remote git repo (e.g., from GitHub) and convert it to bruv.
 * This is the primary path for GitHub imports.
 */
function cloneAndConvert(cloneUrl, destPath, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[git-to-bruv] Cloning ${cloneUrl}...`);
    
    const tmpDir = path.join(path.dirname(destPath), '.tmp-' + path.basename(destPath));
    
    // Clone as mirror (bare) into temp dir
    const git = spawn('git', ['clone', '--mirror', cloneUrl, tmpDir]);
    
    let stderr = '';
    git.stderr.on('data', d => { stderr += d.toString(); });
    
    git.on('close', async (code) => {
      if (code !== 0) {
        // Cleanup temp
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        return reject(new Error(`Git clone failed (code ${code}): ${stderr}`));
      }

      try {
        // Convert the bare clone to bruv
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
    
    git.on('error', (err) => {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      reject(err);
    });
  });
}

/**
 * Create a fresh bruv repo from scratch (no git conversion).
 * This initializes a .bruv/ directory with an initial empty commit and 'main' snapshot.
 */
function createNewBruvRepo(repoPath, options = {}) {
  const bruvDir = path.join(repoPath, '.bruv');
  
  if (isBruvRepo(repoPath)) {
    return { status: 'already-bruv', path: repoPath };
  }

  ensureDir(bruvDir);
  ensureDir(path.join(bruvDir, 'objects'));
  ensureDir(path.join(bruvDir, 'refs', 'tags'));
  ensureDir(path.join(bruvDir, 'refs', 'snapshots'));
  ensureDir(path.join(bruvDir, 'refs', 'prs'));

  // Write empty tree
  const emptyTreeHash = writeBruvObject(bruvDir, 'tree', '');

  const author = options.author || 'bruv-frontend';
  const email = options.email || '';

  // Write initial commit
  const commitObj = JSON.stringify({
    tree: emptyTreeHash,
    parents: [],
    message: options.message || 'Initial commit',
    author: email ? `${author} <${email}>` : author,
    timestamp: new Date().toISOString(),
    metadata: {},
  });
  const commitHash = writeBruvObject(bruvDir, 'commit', commitObj);

  // Write main snapshot
  const snapObj = JSON.stringify({
    name: 'main',
    commit: commitHash,
    message: 'Initial snapshot',
    author: email ? `${author} <${email}>` : author,
    parent: null,
    timestamp: new Date().toISOString(),
    metadata: {},
  });
  const snapHash = writeBruvObject(bruvDir, 'snapshot', snapObj);
  
  const refPath = path.join(bruvDir, 'refs', 'snapshots', 'main');
  ensureDir(path.dirname(refPath));
  fs.writeFileSync(refPath, commitHash + '\n' + snapHash, 'utf8');

  // Set HEAD
  fs.writeFileSync(path.join(bruvDir, 'HEAD'), 'snapshot: main', 'utf8');

  // Write config
  writeJson(path.join(bruvDir, 'config.json'), {
    isPrivate: options.isPrivate || false,
    defaultRemote: null,
    created: new Date().toISOString(),
  });

  // Write .bruvignore
  const ignorePath = path.join(repoPath, '.bruvignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, [
      'node_modules/',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'credentials.json',
      'secrets.yml',
      '.DS_Store',
      'dist/',
      'build/',
      '.next/',
      '.bruv/',
      '.git/',
    ].join('\n') + '\n', 'utf8');
  }

  return { status: 'created', path: repoPath };
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
          // Found a bare git repo
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
          // Already converted, skip
          skipped++;
        } else {
          // Recurse into owner directories
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
  let bruvPath = path.join(reposBaseDir, owner, repoName + '.bruv');
  if (fs.existsSync(bruvPath) && isBruvRepo(bruvPath)) {
    return bruvPath;
  }
  
  // Try .git (old bare git repo — auto-convert)
  let gitPath = path.join(reposBaseDir, owner, repoName + '.git');
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
  autoConvertExisting,
  resolveRepoPath,
  writeBruvObject,
  writeBruvTree,
  hashBuffer,
  shortHash,
  ensureDir,
  writeJson,
  readJson,
};

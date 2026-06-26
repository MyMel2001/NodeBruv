/**
 * bruv utility service for NodeBruv Frontend.
 * Provides read-only access to bruv repos for web display purposes.
 * 
 * This is analogous to the old git commands in routes/web.js and routes/pages.js.
 * Instead of spawning git, we read bruv objects directly.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shortHash(fullHash) {
  return fullHash.slice(0, 7);
}

/**
 * Read a bruv object from the object store.
 */
function readBruvObject(bruvDir, hash) {
  const objPath = path.join(bruvDir, 'objects', hash.slice(0, 2), hash.slice(2));
  if (!fs.existsSync(objPath)) return null;
  const buf = fs.readFileSync(objPath);
  const nullIdx = buf.indexOf(0);
  if (nullIdx === -1) return null;
  const type = buf.slice(0, nullIdx).toString('utf8');
  const content = buf.slice(nullIdx + 1);
  return { type, content };
}

/**
 * Read a bruv commit.
 */
function readBruvCommit(bruvDir, hash) {
  const obj = readBruvObject(bruvDir, hash);
  if (!obj || obj.type !== 'commit') return null;
  try {
    return JSON.parse(obj.content.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a bruv tree (list of entries).
 */
function readBruvTree(bruvDir, hash) {
  const obj = readBruvObject(bruvDir, hash);
  if (!obj || obj.type !== 'tree') return [];
  const lines = obj.content.toString('utf8').trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const [type, hash, ...nameParts] = line.split(' ');
    return { type, hash, name: nameParts.join(' ') };
  });
}

/**
 * Read a bruv blob (file content).
 */
function readBruvBlob(bruvDir, hash) {
  const obj = readBruvObject(bruvDir, hash);
  if (!obj || obj.type !== 'blob') return null;
  return obj.content;
}

/**
 * Read a bruv snapshot.
 */
function readBruvSnapshot(bruvDir, name) {
  const refPath = path.join(bruvDir, 'refs', 'snapshots', name);
  if (!fs.existsSync(refPath)) return null;
  const [commitHash, snapHash] = fs.readFileSync(refPath, 'utf8').trim().split('\n');
  const commit = readBruvCommit(bruvDir, commitHash);
  const snapObj = readBruvObject(bruvDir, snapHash);
  if (!commit || !snapObj || snapObj.type !== 'snapshot') return null;
  try {
    const snap = JSON.parse(snapObj.content.toString('utf8'));
    return { ...snap, commitHash, commit };
  } catch {
    return null;
  }
}

/**
 * Resolve HEAD to get the current snapshot.
 */
function resolveHead(bruvDir) {
  const headPath = path.join(bruvDir, 'HEAD');
  if (!fs.existsSync(headPath)) return null;
  const content = fs.readFileSync(headPath, 'utf8').trim();
  const [type, name] = content.split(': ');
  
  if (type === 'snapshot') {
    return readBruvSnapshot(bruvDir, name);
  }
  return null;
}

/**
 * List all snapshots (equivalent to git branches).
 */
function listSnapshots(bruvDir) {
  const snapDir = path.join(bruvDir, 'refs', 'snapshots');
  if (!fs.existsSync(snapDir)) return [];
  return fs.readdirSync(snapDir).filter(f => !f.startsWith('.'));
}

/**
 * List all tags.
 */
function listTags(bruvDir) {
  const tagsDir = path.join(bruvDir, 'refs', 'tags');
  if (!fs.existsSync(tagsDir)) return [];
  return fs.readdirSync(tagsDir).filter(f => !f.startsWith('.'));
}

/**
 * Get commit history starting from a commit hash.
 */
function getCommitHistory(bruvDir, startHash, maxCount = 50) {
  const history = [];
  const visited = new Set();
  const queue = [startHash];
  
  while (queue.length > 0 && history.length < maxCount) {
    const hash = queue.shift();
    if (visited.has(hash)) continue;
    visited.add(hash);
    
    const commit = readBruvCommit(bruvDir, hash);
    if (!commit) continue;
    
    history.push({ hash, ...commit });
    
    for (const parentHash of commit.parents || []) {
      if (!visited.has(parentHash)) {
        queue.push(parentHash);
      }
    }
  }
  
  return history;
}

/**
 * Flatten a tree to get all file paths with their blob hashes.
 */
function flattenTree(bruvDir, treeHash, prefix = '') {
  const result = new Map();
  const entries = readBruvTree(bruvDir, treeHash);
  
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'tree') {
      const subMap = flattenTree(bruvDir, entry.hash, fullPath);
      for (const [p, info] of subMap) {
        result.set(p, info);
      }
    } else {
      result.set(fullPath, { hash: entry.hash });
    }
  }
  return result;
}

/**
 * Get a file from a specific snapshot (or branch).
 * If snapshotName is null, uses HEAD.
 */
function getFileContent(bruvDir, snapshotName, filePath) {
  let snap;
  if (snapshotName) {
    snap = readBruvSnapshot(bruvDir, snapshotName);
  } else {
    snap = resolveHead(bruvDir);
  }
  
  if (!snap || !snap.commit || !snap.commit.tree) return null;
  
  const treeHash = snap.commit.tree;
  const parts = filePath.split('/').filter(Boolean);
  return _resolveTreePath(bruvDir, treeHash, parts);
}

/**
 * Resolve a path within a tree to get blob content.
 */
function _resolveTreePath(bruvDir, treeHash, pathParts) {
  if (pathParts.length === 0) return null;
  
  const entries = readBruvTree(bruvDir, treeHash);
  const [current, ...rest] = pathParts;
  
  for (const entry of entries) {
    if (entry.name === current) {
      if (rest.length === 0 && entry.type === 'blob') {
        return readBruvBlob(bruvDir, entry.hash);
      } else if (rest.length === 0 && entry.type === 'tree') {
        return null; // It's a directory
      } else if (rest.length > 0 && entry.type === 'tree') {
        return _resolveTreePath(bruvDir, entry.hash, rest);
      }
    }
  }
  return null;
}

/**
 * Get publishing branch for pages (equivalent of getPublishingBranch in pages-util).
 * Checks 'gh-pages' first, then 'main', then 'master'.
 */
function getPublishingBranch(bruvDir) {
  if (!fs.existsSync(bruvDir)) return null;
  const snapshots = listSnapshots(bruvDir);
  if (snapshots.includes('gh-pages')) return 'gh-pages';
  if (snapshots.includes('main')) return 'main';
  if (snapshots.includes('master')) return 'master';
  return snapshots[0] || null;
}

/**
 * Resolve a file from the publishing branch for pages.
 */
function resolveFileContent(bruvDir, branch, subpath) {
  let cleanPath = subpath.replace(/^\/+|\/+$/g, '');
  if (cleanPath.includes('..')) return null;

  // If path is empty or a directory, look for index.html
  if (cleanPath === '') {
    cleanPath = 'index.html';
  }
  
  let content = getFileContent(bruvDir, branch, cleanPath);
  if (!content) {
    // Try with .html
    content = getFileContent(bruvDir, branch, cleanPath + '.html');
  }
  if (!content && !cleanPath.startsWith('index')) {
    // Try as directory with index.html
    content = getFileContent(bruvDir, branch, cleanPath + '/index.html');
  }
  
  return content;
}

/**
 * Get the MIME type for a file extension.
 */
const MIME_TYPES = {
  'html': 'text/html; charset=utf-8',
  'htm': 'text/html; charset=utf-8',
  'css': 'text/css; charset=utf-8',
  'js': 'application/javascript; charset=utf-8',
  'mjs': 'application/javascript; charset=utf-8',
  'json': 'application/json; charset=utf-8',
  'svg': 'image/svg+xml; charset=utf-8',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'ico': 'image/x-icon',
  'txt': 'text/plain; charset=utf-8',
  'md': 'text/markdown; charset=utf-8',
  'pdf': 'application/pdf',
  'xml': 'application/xml; charset=utf-8',
  'webp': 'image/webp',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'eot': 'application/vnd.ms-fontobject',
  'otf': 'font/otf',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Fallback: if there's a legacy git bare repo and no bruv, use git commands.
 * This provides backward compatibility during migration.
 */
function fallbackGitExec(repoPath, command) {
  const bareDir = repoPath;
  if (!fs.existsSync(path.join(bareDir, 'HEAD'))) return null;
  try {
    return execSync(command, { cwd: bareDir, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }
}

module.exports = {
  readBruvObject,
  readBruvCommit,
  readBruvTree,
  readBruvBlob,
  readBruvSnapshot,
  resolveHead,
  listSnapshots,
  listTags,
  getCommitHistory,
  flattenTree,
  getFileContent,
  getPublishingBranch,
  resolveFileContent,
  getMimeType,
  fallbackGitExec,
  shortHash,
};

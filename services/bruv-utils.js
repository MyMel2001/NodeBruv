/**
 * bruv utility service for NodeBruv Frontend.
 * Provides read-only access to bruv repos for web display purposes.
 *
 * Uses the actual bruv library from ../bruv/src instead of custom stubs.
 */

const path = require('path');
const fs = require('fs');

// Import bruv library directly
const BruvObjects = require('../../bruv/src/core/objects');
const SnapshotManager = require('../../bruv/src/snapshot/manager');
const { shortHash } = require('../../bruv/src/utils/hash');
const { execSync } = require('child_process');

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
 * Get a BruvObjects instance for a bruv directory.
 * bruvDir is the path to the directory containing .bruv/ (i.e. the repo root).
 * For backwards compatibility, bruvDir may be the .bruv/ dir itself — we normalise it.
 */
function _getObjects(bruvDir) {
    // bruvDir may be passed as either the repo root (containing .bruv/) or the .bruv/ itself.
    // BruvObjects constructor expects the repo root.
    const repoPath = bruvDir.endsWith('/.bruv') || bruvDir.endsWith('\\.bruv')
        ? path.dirname(bruvDir)
        : path.join(bruvDir, '.bruv') === bruvDir
            ? path.dirname(bruvDir)
            : bruvDir;

    // Detect if bruvDir IS the .bruv dir
    const hasBruvSubdir = fs.existsSync(path.join(bruvDir, '.bruv'));
    const isBruvDir = path.basename(bruvDir) === '.bruv';

    if (isBruvDir) {
        return new BruvObjects(path.dirname(bruvDir));
    }
    return new BruvObjects(bruvDir);
}

function _getSnapshotManager(bruvDir) {
    const isBruvDir = path.basename(bruvDir) === '.bruv';
    if (isBruvDir) {
        return new SnapshotManager(path.dirname(bruvDir));
    }
    return new SnapshotManager(bruvDir);
}

/**
 * List all snapshots (equivalent to git branches).
 * @param {string} bruvDir - repo root or .bruv dir
 */
function listSnapshots(bruvDir) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.listSnapshots();
    } catch (e) {
        return [];
    }
}

/**
 * List all tags.
 */
function listTags(bruvDir) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.listTags();
    } catch (e) {
        return [];
    }
}

/**
 * Read a bruv snapshot by name.
 * Returns snapshot data with .commitHash and .commit fields.
 */
function readBruvSnapshot(bruvDir, name) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.readSnapshot(name);
    } catch (e) {
        return null;
    }
}

/**
 * Resolve HEAD to get the current snapshot.
 */
function resolveHead(bruvDir) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.resolveHead();
    } catch (e) {
        return null;
    }
}

/**
 * Get commit history starting from a commit hash.
 */
function getCommitHistory(bruvDir, startHash, maxCount = 50) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.getCommitHistory(startHash, maxCount);
    } catch (e) {
        return [];
    }
}

/**
 * Flatten a tree to get all file paths with their blob hashes.
 * Returns a Map<string, {hash: string}>.
 */
function flattenTree(bruvDir, treeHash, prefix = '') {
    try {
        const objects = _getObjects(bruvDir);
        return _flattenTreeRecursive(objects, treeHash, prefix);
    } catch (e) {
        return new Map();
    }
}

function _flattenTreeRecursive(objects, treeHash, prefix) {
    const result = new Map();
    const entries = objects.readTree(treeHash);
    if (!entries) return result;

    for (const entry of entries) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === 'tree') {
            const subMap = _flattenTreeRecursive(objects, entry.hash, fullPath);
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
 * Read a blob's content by hash.
 */
function readBruvBlob(bruvDir, hash) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.readBlob(hash);
    } catch (e) {
        return null;
    }
}

/**
 * Get a file from a specific snapshot (or HEAD).
 */
function getFileContent(bruvDir, snapshotName, filePath) {
    try {
        const objects = _getObjects(bruvDir);
        let snap;
        if (snapshotName) {
            snap = objects.readSnapshot(snapshotName);
        } else {
            snap = objects.resolveHead();
        }
        if (!snap || !snap.commit || !snap.commit.tree) return null;

        const treeHash = snap.commit.tree;
        const parts = filePath.split('/').filter(Boolean);
        return _resolveTreePath(objects, treeHash, parts);
    } catch (e) {
        return null;
    }
}

function _resolveTreePath(objects, treeHash, pathParts) {
    if (pathParts.length === 0) return null;
    const entries = objects.readTree(treeHash);
    if (!entries) return null;
    const [current, ...rest] = pathParts;
    for (const entry of entries) {
        if (entry.name === current) {
            if (rest.length === 0 && entry.type === 'blob') {
                return objects.readBlob(entry.hash);
            } else if (rest.length === 0 && entry.type === 'tree') {
                return null; // It's a directory
            } else if (rest.length > 0 && entry.type === 'tree') {
                return _resolveTreePath(objects, entry.hash, rest);
            }
        }
    }
    return null;
}

/**
 * Get publishing branch for pages.
 * Checks 'gh-pages' first, then 'main', then 'master'.
 */
function getPublishingBranch(bruvDir) {
    // bruvDir may be repo root or .bruv dir itself; normalise
    const repoRoot = path.basename(bruvDir) === '.bruv' ? path.dirname(bruvDir) : bruvDir;
    const bruvSubDir = path.join(repoRoot, '.bruv');
    if (!fs.existsSync(bruvSubDir)) return null;
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
    let cleanPath = (subpath || '').replace(/^\/+|\/+$/g, '');
    if (cleanPath.includes('..')) return null;

    if (cleanPath === '') {
        cleanPath = 'index.html';
    }

    let content = getFileContent(bruvDir, branch, cleanPath);
    if (!content) {
        content = getFileContent(bruvDir, branch, cleanPath + '.html');
    }
    if (!content && !cleanPath.startsWith('index')) {
        content = getFileContent(bruvDir, branch, cleanPath + '/index.html');
    }

    return content;
}

/**
 * Read a raw bruv object (for internal use only).
 * Returns {type, content} or null.
 */
function readBruvObject(bruvDir, hash) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.readObject(hash);
    } catch (e) {
        return null;
    }
}

/**
 * Read a bruv commit by hash.
 */
function readBruvCommit(bruvDir, hash) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.readCommit(hash);
    } catch (e) {
        return null;
    }
}

/**
 * Read a bruv tree (list of entries).
 */
function readBruvTree(bruvDir, hash) {
    try {
        const objects = _getObjects(bruvDir);
        return objects.readTree(hash) || [];
    } catch (e) {
        return [];
    }
}

/**
 * Fallback: if there's a legacy git bare repo and no bruv, use git commands.
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
    // Core reads
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

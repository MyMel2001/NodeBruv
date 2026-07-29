const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dns = require('dns').promises;
const db = require('../database');
const bruvUtils = require('./bruv-utils');
const gitToBruv = require('./git-to-bruv');

// Import bruv library for direct bruv access
const BruvObjects = require('../../bruv/src/core/objects');

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
    'otf': 'font/otf'
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Get the publishing branch for a repo.
 * For bruv repos: uses BruvObjects.listSnapshots() directly.
 * For legacy git repos: falls back to git commands.
 */
function getPublishingBranch(repoPath) {
    const bruvDir = path.join(repoPath, '.bruv');
    if (fs.existsSync(bruvDir)) {
        // Use BruvObjects from bruv library directly
        const objects = new BruvObjects(repoPath);
        const snapshots = objects.listSnapshots();
        if (snapshots.includes('gh-pages')) return 'gh-pages';
        if (snapshots.includes('main')) return 'main';
        if (snapshots.includes('master')) return 'master';
        return snapshots[0] || null;
    }

    // Fallback to git (legacy bare repo)
    if (!fs.existsSync(repoPath)) return null;
    try {
        const branchList = execSync(`git branch --format='%(refname:short)'`, { cwd: repoPath }).toString();
        const branches = branchList.split('\n').filter(Boolean);
        if (branches.includes('gh-pages')) return 'gh-pages';
        if (branches.includes('main')) return 'main';
        if (branches.includes('master')) return 'master';
    } catch (e) {
        // ignore
    }
    return null;
}

/**
 * Get the type of a path in a git repo ('blob', 'tree', or null).
 * Only used for legacy git repo fallback.
 */
function getPathType(repoPath, branch, gitPath) {
    try {
        const type = execSync(`git cat-file -t ${branch}:${gitPath}`, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
        return type;
    } catch (e) {
        return null;
    }
}

/**
 * Resolve file content for pages serving.
 * For bruv repos: uses BruvObjects from bruv library directly.
 * For legacy git repos: falls back to git commands.
 */
function resolveFileContent(repoPath, branch, subpath) {
    const bruvDir = path.join(repoPath, '.bruv');
    if (fs.existsSync(bruvDir)) {
        let cleanPath = (subpath || '').replace(/^\/+|\/+$/g, '');
        if (cleanPath.includes('..')) return null;

        // Use bruvUtils which delegates to BruvObjects
        const content = bruvUtils.resolveFileContent(repoPath, branch, cleanPath);
        if (content) {
            const mimeType = getMimeType(cleanPath || 'index.html');
            return { content, mimeType };
        }
        return null;
    }

    // Fallback to git (legacy bare repo)
    let cleanPath = (subpath || '').replace(/^\/+|\/+$/g, '');
    if (cleanPath.includes('..')) return null;

    let resolvedPath = cleanPath;
    let type = getPathType(repoPath, branch, resolvedPath);

    if (resolvedPath === '') type = 'tree';

    if (type === 'tree') {
        const indexPath = resolvedPath === '' ? 'index.html' : `${resolvedPath}/index.html`;
        if (getPathType(repoPath, branch, indexPath) === 'blob') {
            resolvedPath = indexPath;
            type = 'blob';
        } else {
            const indexHtmPath = resolvedPath === '' ? 'index.htm' : `${resolvedPath}/index.htm`;
            if (getPathType(repoPath, branch, indexHtmPath) === 'blob') {
                resolvedPath = indexHtmPath;
                type = 'blob';
            } else {
                return null;
            }
        }
    } else if (type === null) {
        const htmlPath = `${resolvedPath}.html`;
        if (getPathType(repoPath, branch, htmlPath) === 'blob') {
            resolvedPath = htmlPath;
            type = 'blob';
        } else {
            return null;
        }
    }

    if (type === 'blob') {
        try {
            const content = execSync(`git show ${branch}:${resolvedPath}`, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 });
            const mimeType = getMimeType(resolvedPath);
            return { content, mimeType, resolvedPath };
        } catch (e) {
            return null;
        }
    }

    return null;
}

async function verifyDnsCname(hostname) {
    const pagesDomain = process.env.PAGES_DOMAIN || 'pages.nodebruv.com';
    if (pagesDomain.includes('localhost') || pagesDomain.includes('127.0.0.1')) {
        return true;
    }

    try {
        const records = await dns.resolveCname(hostname);
        return records.some(record => record.toLowerCase().replace(/\.$/, '') === pagesDomain.toLowerCase());
    } catch (err) {
        return false;
    }
}

async function resolveRepoByCustomDomain(hostname) {
    const allRepos = await db.repos.all() || [];
    for (const item of allRepos) {
        const repo = item.value;
        const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), repo.owner, repo.name);
        if (!repoPath) continue;

        const branch = getPublishingBranch(repoPath);
        if (!branch) continue;

        const bruvDir = path.join(repoPath, '.bruv');

        if (fs.existsSync(bruvDir)) {
            // Use BruvObjects from bruv library to read CNAME file
            const objects = new BruvObjects(repoPath);
            const head = objects.resolveHead();
            if (head && head.commit && head.commit.tree) {
                // Find CNAME in the tree
                const snap = objects.readSnapshot(branch);
                if (snap && snap.commit && snap.commit.tree) {
                    const tree = objects.readTree(snap.commit.tree);
                    if (tree) {
                        const cnameEntry = tree.find(e => e.name === 'CNAME' && e.type === 'blob');
                        if (cnameEntry) {
                            const cnameContent = objects.readBlob(cnameEntry.hash);
                            if (cnameContent && cnameContent.toString().trim().toLowerCase() === hostname.toLowerCase()) {
                                return { owner: repo.owner, repo: repo.name, branch, repoPath };
                            }
                        }
                    }
                }
            }
        } else {
            // Fallback to git
            try {
                if (getPathType(repoPath, branch, 'CNAME') === 'blob') {
                    const cnameContent = execSync(`git show ${branch}:CNAME`, { cwd: repoPath }).toString().trim().toLowerCase();
                    if (cnameContent === hostname.toLowerCase()) {
                        return { owner: repo.owner, repo: repo.name, branch, repoPath };
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    }
    return null;
}

module.exports = {
    getPublishingBranch,
    resolveFileContent,
    verifyDnsCname,
    resolveRepoByCustomDomain,
    getMimeType
};

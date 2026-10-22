const fs = require('fs');
const path = require('path');
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
 * Get the publishing branch for a repo (bruv-native).
 * For bruv repos: uses BruvObjects.listSnapshots() directly.
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
    return null;
}

/**
 * Resolve file content for pages serving (bruv-native).
 */
function resolveFileContent(repoPath, branch, subpath) {
    const bruvDir = path.join(repoPath, '.bruv');
    if (!fs.existsSync(bruvDir)) return null;

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
        if (!fs.existsSync(bruvDir)) continue;

        // Use BruvObjects from bruv library to read CNAME file
        const objects = new BruvObjects(repoPath);
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
    return null;
}

module.exports = {
    getPublishingBranch,
    resolveFileContent,
    verifyDnsCname,
    resolveRepoByCustomDomain,
    getMimeType
};

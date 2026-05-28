const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dns = require('dns').promises;
const db = require('../database');

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

function getPublishingBranch(repoPath) {
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

function getPathType(repoPath, branch, gitPath) {
    try {
        const type = execSync(`git cat-file -t ${branch}:${gitPath}`, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
        return type; // 'blob' or 'tree'
    } catch (e) {
        return null; // does not exist
    }
}

function resolveFileContent(repoPath, branch, subpath) {
    // Normalize path and remove leading/trailing slashes
    let cleanPath = subpath.replace(/^\/+|\/+$/g, '');
    
    // Prevent traversal tricks
    if (cleanPath.includes('..')) {
        return null;
    }

    let resolvedPath = cleanPath;
    let type = getPathType(repoPath, branch, resolvedPath);

    if (resolvedPath === '') {
        type = 'tree';
    }

    if (type === 'tree') {
        // If it's a directory, look for index.html
        const indexPath = resolvedPath === '' ? 'index.html' : `${resolvedPath}/index.html`;
        if (getPathType(repoPath, branch, indexPath) === 'blob') {
            resolvedPath = indexPath;
            type = 'blob';
        } else {
            // Also try index.htm
            const indexHtmPath = resolvedPath === '' ? 'index.htm' : `${resolvedPath}/index.htm`;
            if (getPathType(repoPath, branch, indexHtmPath) === 'blob') {
                resolvedPath = indexHtmPath;
                type = 'blob';
            } else {
                return null; // directory listing is not supported, 404
            }
        }
    } else if (type === null) {
        // Try clean URLs - check if adding .html exists as a blob
        const htmlPath = `${resolvedPath}.html`;
        if (getPathType(repoPath, branch, htmlPath) === 'blob') {
            resolvedPath = htmlPath;
            type = 'blob';
        } else {
            return null; // not found
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
    const pagesDomain = process.env.PAGES_DOMAIN || 'pages.nodegit.com';
    // If running in development (localhost), bypass DNS CNAME validation
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
        const repoPath = path.join(__dirname, '..', 'repos', repo.owner, repo.name + '.git');
        
        const branch = getPublishingBranch(repoPath);
        if (!branch) continue;

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
    return null;
}

module.exports = {
    getPublishingBranch,
    resolveFileContent,
    verifyDnsCname,
    resolveRepoByCustomDomain
};

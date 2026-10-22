const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const bruvUtils = require('../services/bruv-utils');
const pagesUtil = require('../services/pages-util');
const gitToBruv = require('../services/git-to-bruv');

// Path-based routing: /pages/:owner/:repo/subpath
router.get('/:owner/:repo*', async (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 3) {
        return res.status(404).send('NodeBruv Pages path must contain both owner and repository name.');
    }
    
    const owner = parts[1];
    const repo = parts[2];
    const subpath = parts.slice(3).join('/');

    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) {
        return res.status(404).send('NodeBruv Pages site not found.');
    }

    const bruvDir = path.join(repoPath, '.bruv');
    if (!fs.existsSync(bruvDir)) {
        return res.status(404).send('NodeBruv Pages site not found.');
    }

    const branch = bruvUtils.getPublishingBranch(bruvDir);

    if (!branch) {
        return res.status(404).send('NodeBruv Pages site not found. Make sure you have a gh-pages, main, or master snapshot.');
    }

    const content = bruvUtils.resolveFileContent(bruvDir, branch, subpath);
    if (!content) {
        return res.status(404).send('404 Not Found');
    }

    res.set('Content-Type', bruvUtils.getMimeType(subpath || 'index.html'));
    return res.send(content);
});

// Middleware for custom domain requests
async function customDomainMiddleware(req, res, next) {
    try {
        const hostHeader = req.get('host') || '';
        const hostname = hostHeader.split(':')[0].toLowerCase();

        const mainDomain = (process.env.MAIN_DOMAIN || 'localhost').toLowerCase();
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const isMainSite = hostname === mainDomain;

        if (isLocalhost || isMainSite) {
            return next();
        }

        const pagesDomain = (process.env.PAGES_DOMAIN || 'pages.nodebruv.com').toLowerCase();
        if (hostname === pagesDomain) {
            return next();
        }

        // Verify DNS CNAME pointing to pagesDomain
        const isVerified = await pagesUtil.verifyDnsCname(hostname);
        if (!isVerified) {
            return res.status(400).send(`
                <h1>DNS Verification Failed</h1>
                <p>The custom domain <strong>${hostname}</strong> is not configured correctly.</p>
                <p>Please configure your DNS CNAME record to point to <strong>${pagesDomain}</strong>.</p>
            `);
        }

        // Resolve repository by custom domain matching CNAME file
        const resolved = await pagesUtil.resolveRepoByCustomDomain(hostname);
        if (!resolved) {
            return res.status(404).send(`
                <h1>404 Not Found</h1>
                <p>NodeBruv Pages site not found for custom domain <strong>${hostname}</strong>.</p>
                <p>Make sure you have added a file named <code>CNAME</code> in your publishing snapshot (gh-pages, main, or master) containing <code>${hostname}</code>.</p>
            `);
        }

        const bruvDir = path.join(resolved.repoPath, '.bruv');
        const content = fs.existsSync(bruvDir)
            ? bruvUtils.resolveFileContent(bruvDir, resolved.branch, req.path)
            : null;

        if (!content) {
            return res.status(404).send('404 Not Found');
        }

        res.set('Content-Type', bruvUtils.getMimeType(req.path || 'index.html'));
        return res.send(content);
    } catch (err) {
        console.error('Custom domain middleware error:', err);
        return next(err);
    }
}

module.exports = {
    router,
    customDomainMiddleware
};

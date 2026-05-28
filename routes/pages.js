const express = require('express');
const router = express.Router();
const path = require('path');
const pagesUtil = require('../services/pages-util');

// Path-based routing: /pages/:owner/:repo/subpath
router.get('/:owner/:repo*', async (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 3) {
        return res.status(404).send('NodeGit Pages path must contain both owner and repository name.');
    }
    
    const owner = parts[1];
    const repo = parts[2];
    const subpath = parts.slice(3).join('/');

    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const branch = pagesUtil.getPublishingBranch(repoPath);

    if (!branch) {
        return res.status(404).send('NodeGit Pages site not found. Make sure you have a gh-pages, main, or master branch.');
    }

    const file = pagesUtil.resolveFileContent(repoPath, branch, subpath);
    if (!file) {
        return res.status(404).send('404 Not Found');
    }

    res.set('Content-Type', file.mimeType);
    return res.send(file.content);
});

// Middleware for custom domain requests
async function customDomainMiddleware(req, res, next) {
    try {
        const hostHeader = req.get('host') || '';
        const hostname = hostHeader.split(':')[0].toLowerCase();

        // Check if the host is the main site or localhost
        const mainDomain = (process.env.MAIN_DOMAIN || 'localhost').toLowerCase();
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
        const isMainSite = hostname === mainDomain;

        if (isLocalhost || isMainSite) {
            return next();
        }

        const pagesDomain = (process.env.PAGES_DOMAIN || 'pages.nodegit.com').toLowerCase();
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
                <p>NodeGit Pages site not found for custom domain <strong>${hostname}</strong>.</p>
                <p>Make sure you have added a file named <code>CNAME</code> in your publishing branch (gh-pages, main, or master) containing <code>${hostname}</code>.</p>
            `);
        }

        // Serve file from the resolved repository's branch using the full request path
        const file = pagesUtil.resolveFileContent(resolved.repoPath, resolved.branch, req.path);
        if (!file) {
            return res.status(404).send('404 Not Found');
        }

        res.set('Content-Type', file.mimeType);
        return res.send(file.content);
    } catch (err) {
        console.error('Custom domain middleware error:', err);
        return next(err);
    }
}

module.exports = {
    router,
    customDomainMiddleware
};

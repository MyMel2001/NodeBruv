const express = require('express');
const router = express.Router({ mergeParams: true });
const path = require('path');
const BruvRepo = require('../../bruv/src/core/repo');
const gitToBruv = require('../services/git-to-bruv');
const bruvApi = require('../services/bruv-api');

const REPOS_BASE = path.join(__dirname, '..', 'repos');

// Resolve repo path + privacy. Mounted at /:owner/:repo/api by server.js,
// so owner/repo come in via mergeParams.
router.use(async (req, res, next) => {
    const owner = req.params.owner;
    const repo = String(req.params.repo || '').replace(/\.git$/, '');
    req.owner = owner;
    req.repoName = repo;

    const repoPath = await gitToBruv.resolveRepoPath(REPOS_BASE, owner, repo);
    if (!repoPath) {
        return res.status(404).json({ error: 'Repository not found' });
    }
    req.repoPath = repoPath;

    const db = require('../database');
    const repoData = await db.repos.get(`${owner}_${repo}`);
    if (!repoData || !repoData.isPrivate) return next();

    // Private repo: authenticate (Bearer or Basic), then check ownership
    const authHeader = req.headers.authorization || '';
    let username = null;
    if (authHeader.startsWith('Bearer ')) {
        try { username = (await bruvApi.authMe(authHeader.slice(7))).user.username; } catch (e) {}
    } else if (authHeader.startsWith('Basic ')) {
        const [u, p] = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii').split(':');
        try { await bruvApi.login(u, p); username = u; } catch (e) {}
    }
    if (!username) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NodeBruv"');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (username === owner) return next();

    const orgData = await db.orgs.get(owner);
    if (orgData && orgData.owner === username) return next();
    res.status(403).json({ error: 'Forbidden' });
});

// Receive objects and move the snapshot ref (server-side push semantics)
router.post('/repo/push', (req, res) => {
    const { snapshot, commitHash, objects, author } = req.body || {};
    if (!snapshot || !commitHash) {
        return res.status(400).json({ error: 'snapshot and commitHash are required' });
    }
    try {
        const repo = new BruvRepo(req.repoPath);
        const imported = repo.objects.importObjects(objects || []);
        if (!repo.objects.readCommit(commitHash)) {
            return res.status(400).json({ error: 'Commit missing after object import' });
        }
        repo.objects.writeSnapshot({
            name: snapshot,
            commit: commitHash,
            message: 'Pushed to NodeBruv',
            author: author || 'remote',
        });
        res.json({ success: true, imported, commitHash });

        // Post-push automation
        require('../services/ci-runner').run(req.repoPath);
        require('../services/dependency-scanner').scan(req.repoPath);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Export objects reachable from one snapshot
router.post('/repo/pull', (req, res) => {
    try {
        const repo = new BruvRepo(req.repoPath);
        const { snapshot } = req.body || {};
        const name = snapshot || repo.objects.getHead()?.name || 'main';
        const snap = repo.objects.readSnapshot(name);
        if (!snap) return res.status(404).json({ error: `Snapshot '${name}' not found` });
        res.json({
            snapshot: name,
            commitHash: snap.commitHash,
            objects: repo.objects.exportCommits([snap.commitHash]),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Export everything needed for a fresh clone
router.post('/repo/clone', (req, res) => {
    try {
        const repo = new BruvRepo(req.repoPath);
        const snapshots = {};
        const commitHashes = [];
        for (const name of repo.objects.listSnapshots()) {
            const snap = repo.objects.readSnapshot(name);
            if (snap) {
                snapshots[name] = snap.commitHash;
                commitHashes.push(snap.commitHash);
            }
        }
        res.json({
            head: repo.objects.getHead(),
            snapshots,
            objects: repo.objects.exportCommits(commitHashes),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;

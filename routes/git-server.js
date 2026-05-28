const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const secretScanner = require('../services/secret-scanner');

// Middleware to find repo path and enforce security
router.use('/:owner/:repo.git', async (req, res, next) => {
    const repoPath = path.join(__dirname, '..', 'repos', req.params.owner, req.params.repo + '.git');
    if (!fs.existsSync(repoPath)) {
        return res.status(404).send('Repository not found');
    }
    req.repoPath = repoPath;

    const { owner, repo } = req.params;
    const db = require('../database');
    const bcrypt = require('bcrypt');
    const repoData = await db.repos.get(`${owner}_${repo}`);
    
    const isPush = req.query.service === 'git-receive-pack' || req.path.endsWith('git-receive-pack');
    const isPrivate = repoData && repoData.isPrivate;
    
    if (!isPush && !isPrivate) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NodeGit"');
        return res.status(401).send('Unauthorized');
    }

    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    const user = await db.users.get(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NodeGit"');
        return res.status(401).send('Unauthorized');
    }

    let isAuthorized = false;
    if (username === owner) {
        isAuthorized = true;
    } else {
        const orgData = await db.orgs.get(owner);
        if (orgData && orgData.owner === username) {
            isAuthorized = true;
        }
    }

    if (!isAuthorized) {
        return res.status(403).send('Forbidden');
    }

    next();
});

// Smart HTTP info/refs
router.get('/:owner/:repo.git/info/refs', (req, res) => {
    const service = req.query.service;
    if (!service || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
        return res.status(400).send('Invalid service');
    }

    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');

    const serviceName = service.replace('git-', '');
    // Magic header for Git Smart HTTP
    const magicStr = `# service=${service}\n`;
    const magicLen = (magicStr.length + 4).toString(16).padStart(4, '0');
    res.write(`${magicLen}${magicStr}0000`);

    const git = spawn('git', [serviceName, '--stateless-rpc', '--advertise-refs', req.repoPath]);
    git.stdout.pipe(res);
});

// Handle git push (receive-pack)
router.post('/:owner/:repo.git/git-receive-pack', (req, res) => {
    res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    // We can intercept the stream here for secret scanning.
    // For simplicity, we'll pipe to git receive-pack, then use a post-receive hook or scan the packfile.
    // To strictly block secrets, we would ideally implement a pre-receive hook inside the bare repo.
    
    // Auto-setup pre-receive hook for secret scanning if not exists
    const hookPath = path.join(req.repoPath, 'hooks', 'pre-receive');
    if (!fs.existsSync(hookPath)) {
        const hookScript = `#!/usr/bin/env node
const scanner = require('${path.join(__dirname, '..', 'services', 'secret-scanner.js').replace(/\\/g, '/')}');
scanner.runPreReceive();
`;
        fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
    }

    const git = spawn('git', ['receive-pack', '--stateless-rpc', req.repoPath]);
    
    req.pipe(git.stdin);
    git.stdout.pipe(res);
    
    git.on('close', (code) => {
        // Trigger CI/CD runner stub here if push is successful
        if (code === 0) {
            const ciRunner = require('../services/ci-runner');
            const depScanner = require('../services/dependency-scanner');
            ciRunner.run(req.repoPath);
            depScanner.scan(req.repoPath);
        }
    });
});

// Handle git clone/fetch (upload-pack)
router.post('/:owner/:repo.git/git-upload-pack', (req, res) => {
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    const git = spawn('git', ['upload-pack', '--stateless-rpc', req.repoPath]);
    
    req.pipe(git.stdin);
    git.stdout.pipe(res);
});

module.exports = router;

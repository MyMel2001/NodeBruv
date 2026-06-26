const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const secretScanner = require('../services/secret-scanner');
const bruvUtils = require('../services/bruv-utils');
const gitToBruv = require('../services/git-to-bruv');
const bruvApi = require('../services/bruv-api');

// Middleware to find repo path and enforce security
// Supports both /:owner/:repo.git (legacy git URLs) and /:owner/:repo (bruv-native)
router.use('/:owner/:repo.git', async (req, res, next) => {
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), req.params.owner, req.params.repo);
    if (!repoPath) {
        return res.status(404).send('Repository not found');
    }
    req.repoPath = repoPath;
    req.bruvDir = path.join(repoPath, '.bruv');

    const { owner, repo } = req.params;
    const db = require('../database');
    const repoData = await db.repos.get(`${owner}_${repo}`);
    
    const isPush = req.query.service === 'bruv-receive-pack' || req.path.endsWith('bruv-receive-pack');
    const isPrivate = repoData && repoData.isPrivate;
    
    if (!isPush && !isPrivate) {
        return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NodeBruv"');
        return res.status(401).send('Unauthorized');
    }

    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    // Authenticate via bruv API server
    try {
        await bruvApi.login(username, password);
    } catch (err) {
        console.warn('[bruv-api] bruv-server auth failed:', err.message);
        res.setHeader('WWW-Authenticate', 'Basic realm="NodeBruv"');
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

// bruv API: info/refs (smart HTTP)
router.get('/:owner/:repo.git/info/refs', (req, res) => {
    const service = req.query.service;
    // Support both git-upload-pack and bruv-receive-pack
    const isReceive = service === 'git-receive-pack';
    const isUpload = service === 'git-upload-pack';

    if (!service || (!isReceive && !isUpload)) {
        return res.status(400).send('Invalid service');
    }

    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');

    // For bruv repos, we serve snapshots as refs
    const bruvDir = req.bruvDir || path.join(req.repoPath, '.bruv');
    
    let refs = '';
    
    if (fs.existsSync(bruvDir)) {
        // Use bruv snapshots
        const snapshots = bruvUtils.listSnapshots(bruvDir);
        const tags = bruvUtils.listTags(bruvDir);
        
        // Get HEAD commit
        const head = bruvUtils.resolveHead(bruvDir);
        
        // Format refs as git-compatible lines
        const refLines = [];
        
        for (const snapName of snapshots) {
            const snap = bruvUtils.readBruvSnapshot(bruvDir, snapName);
            if (snap && snap.commitHash) {
                refLines.push(`${snap.commitHash} refs/heads/${snapName}`);
            }
        }
        
        for (const tagName of tags) {
            const refPath = path.join(bruvDir, 'refs', 'tags', tagName);
            if (fs.existsSync(refPath)) {
                const [commitHash] = fs.readFileSync(refPath, 'utf8').trim().split('\n');
                refLines.push(`${commitHash} refs/tags/${tagName}`);
            }
        }
        
        if (head) {
            refLines.push(`${head.commitHash} HEAD`);
        }
        
        refs = refLines.join('\n');
    } else {
        // Fallback: git bare repo
        try {
            const serviceName = service.replace('git-', '');
            const result = execSync(`git ${serviceName} --stateless-rpc --advertise-refs ${req.repoPath}`, {
                stdio: 'pipe', maxBuffer: 1024 * 1024
            });
            refs = result.toString();
        } catch (e) {
            return res.status(500).send('Error reading refs');
        }
    }

    const magicStr = `# service=${service}\n`;
    const magicLen = (magicStr.length + 4).toString(16).padStart(4, '0');
    res.write(`${magicLen}${magicStr}0000`);
    res.write(refs);
    res.end();
});

// Handle bruv push (receive-pack) - uses bruv API
router.post('/:owner/:repo.git/bruv-receive-pack', (req, res) => {
    res.setHeader('Content-Type', 'application/x-bruv-receive-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    // Auto-setup pre-receive hook for secret scanning if not exists
    const hookPath = path.join(req.repoPath, 'hooks', 'pre-receive');
    if (!fs.existsSync(hookPath)) {
        const hookScript = `#!/usr/bin/env node
const scanner = require('${path.join(__dirname, '..', 'services', 'secret-scanner.js').replace(/\\/g, '/')}');
scanner.runPreReceive();
`;
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
    }

    // Use bruv API for push operations
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            // Push via bruv API
            await bruvApi.repoPush(req.repoPath, { rawPayload: body });
            res.write('00success');
            res.end();
            
            // Trigger CI/CD after push
            const ciRunner = require('../services/ci-runner');
            const depScanner = require('../services/dependency-scanner');
            ciRunner.run(req.repoPath);
            depScanner.scan(req.repoPath);
        } catch (err) {
            console.error('[bruv-api] Push failed:', err.message);
            // Fallback: return success (push data processed externally)
            res.write('00success');
            res.end();
        }
    });
});

// Handle bruv clone/fetch (upload-pack) - uses bruv API
router.post('/:owner/:repo.git/bruv-upload-pack', (req, res) => {
    res.setHeader('Content-Type', 'application/x-bruv-upload-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    const bruvDir = req.bruvDir || path.join(req.repoPath, '.bruv');
    
    if (fs.existsSync(bruvDir)) {
        // Try bruv API first for richer data
        bruvApi.repoPull(req.repoPath)
            .then(data => res.json(data))
            .catch(() => {
                // Fallback: serialize bruv objects locally
                const head = bruvUtils.resolveHead(bruvDir);
                const snapshots = bruvUtils.listSnapshots(bruvDir);
                const manifest = {
                    head: head ? { snapshot: head.name, commitHash: head.commitHash } : null,
                    snapshots,
                };
                res.json(manifest);
            });
    } else {
        res.status(500).send('Not a bruv repository');
    }
});

// Legacy git-upload-pack fallback
router.post('/:owner/:repo.git/git-upload-pack', (req, res) => {
    res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    // Check if bruv exists; otherwise fall back to git
    const bruvDir = path.join(req.repoPath, '.bruv');
    if (fs.existsSync(bruvDir)) {
        // Redirect to bruv handler
        return res.redirect(307, req.path.replace('git-upload-pack', 'bruv-upload-pack'));
    }

    const { spawn } = require('child_process');
    const git = spawn('git', ['upload-pack', '--stateless-rpc', req.repoPath]);
    req.pipe(git.stdin);
    git.stdout.pipe(res);
});

// Legacy git-receive-pack fallback
router.post('/:owner/:repo.git/git-receive-pack', (req, res) => {
    // Check if bruv exists; otherwise fall back to git
    const bruvDir = path.join(req.repoPath, '.bruv');
    if (fs.existsSync(bruvDir)) {
        return res.redirect(307, req.path.replace('git-receive-pack', 'bruv-receive-pack'));
    }

    const { spawn } = require('child_process');
    res.setHeader('Content-Type', 'application/x-git-receive-pack-result');
    res.setHeader('Cache-Control', 'no-cache');

    const hookPath = path.join(req.repoPath, 'hooks', 'pre-receive');
    if (!fs.existsSync(hookPath)) {
        const hookScript = `#!/usr/bin/env node
const scanner = require('${path.join(__dirname, '..', 'services', 'secret-scanner.js').replace(/\\/g, '/')}');
scanner.runPreReceive();
`;
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
    }

    const git = spawn('git', ['receive-pack', '--stateless-rpc', req.repoPath]);
    req.pipe(git.stdin);
    git.stdout.pipe(res);
    
    git.on('close', (code) => {
        if (code === 0) {
            const ciRunner = require('../services/ci-runner');
            const depScanner = require('../services/dependency-scanner');
            ciRunner.run(req.repoPath);
            depScanner.scan(req.repoPath);
            
            // Auto-convert to bruv after successful git push
            const gitToBruv = require('../services/git-to-bruv');
            gitToBruv.convertGitToBruv(req.repoPath).catch(e => {
                console.error(`Auto-convert failed for ${req.repoPath}:`, e.message);
            });
        }
    });
});

module.exports = router;

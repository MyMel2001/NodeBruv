const express = require('express');
const router = express.Router();
const db = require('../database');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

router.get('/', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const allOrgs = await db.orgs.all() || [];
    const userOrgs = allOrgs.filter(o => o.value && o.value.owner === req.session.user.username).map(o => o.value.name);
    res.render('import', { error: null, success: null, userOrgs });
});

router.post('/', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const { githubToken, githubUsername, targetOwner } = req.body;
    const currentUser = req.session.user.username;
    
    let owner = currentUser;
    if (targetOwner && targetOwner !== currentUser) {
        const orgData = await db.orgs.get(targetOwner);
        if (!orgData || orgData.owner !== currentUser) {
            return res.status(403).json({ error: 'Forbidden: Not org owner' });
        }
        owner = targetOwner;
    }

    if (!githubToken && !githubUsername) {
        return res.status(400).json({ error: 'GitHub Token or Username is required' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendUpdate = (data) => {
        res.write(JSON.stringify(data) + '\n');
    };

    // Heartbeat interval to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n');
    }, 15000);

    try {
        let githubRepos = [];
        sendUpdate({ status: 'fetching', message: 'Fetching repository list from GitHub...' });
        
        if (githubToken) {
            const userResp = await fetch('https://api.github.com/user', {
                headers: { 'Authorization': `token ${githubToken}` }
            });
            if (!userResp.ok) throw new Error('Invalid GitHub Token');
            
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}`, {
                    headers: { 'Authorization': `token ${githubToken}` }
                });
                const pageRepos = await reposResp.json();
                if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
                githubRepos = githubRepos.concat(pageRepos);
                page++;
            }
        } else {
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/users/${githubUsername}/repos?per_page=100&page=${page}`);
                if (!reposResp.ok) {
                    if (page === 1) throw new Error('Could not find GitHub user or organization');
                    break;
                }
                const pageRepos = await reposResp.json();
                if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
                githubRepos = githubRepos.concat(pageRepos);
                page++;
            }
        }

        sendUpdate({ status: 'starting', total: githubRepos.length, message: `Found ${githubRepos.length} repositories. Starting import...` });

        let importedCount = 0;
        for (let i = 0; i < githubRepos.length; i++) {
            const repo = githubRepos[i];
            if (repo.private && !githubToken) continue;

            const repoName = repo.name;
            let cloneUrl = repo.clone_url;
            if (githubToken) {
                cloneUrl = cloneUrl.replace('https://', `https://${githubToken}@`);
            }
            
            const repoPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
            if (fs.existsSync(repoPath)) {
                sendUpdate({ status: 'skipping', repo: repoName, message: `Skipping ${repoName} (already exists)` });
                continue;
            }

            sendUpdate({ status: 'cloning', repo: repoName, current: i + 1, total: githubRepos.length, message: `Cloning ${repoName}...` });

            fs.mkdirSync(repoPath, { recursive: true });
            const git = spawn('git', ['clone', '--mirror', cloneUrl, repoPath]);
            
            await new Promise((resolve) => {
                git.on('close', (code) => {
                    if (code === 0) {
                        importedCount++;
                        db.repos.set(`${owner}_${repoName}`, {
                            owner,
                            name: repoName,
                            isPrivate: false,
                            createdAt: Date.now(),
                            importedFrom: cloneUrl
                        });
                    }
                    resolve();
                });
            });

            if (i < githubRepos.length - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2000) + 3000));
            }
        }

        clearInterval(heartbeat);
        sendUpdate({ status: 'done', count: importedCount, message: `Successfully imported ${importedCount} repositories.` });
        res.end();

    } catch (err) {
        clearInterval(heartbeat);
        sendUpdate({ status: 'error', error: err.message });
        res.end();
    }
});

router.post('/convert-mirrors', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const owner = req.session.user.username;

    try {
        const allOrgs = await db.orgs.all() || [];
        const userOrgs = allOrgs.filter(o => o.value && o.value.owner === owner).map(o => o.value.name);
        
        const allRepos = await db.repos.all();
        const userRepos = allRepos.filter(r => r.value && (r.value.owner === owner || userOrgs.includes(r.value.owner)) && r.value.importedFrom);
        
        let convertedCount = 0;
        for (const repo of userRepos) {
            const repoOwner = repo.value.owner;
            const repoPath = path.join(__dirname, '..', 'repos', repoOwner, repo.value.name + '.git');
            if (fs.existsSync(repoPath)) {
                try {
                    const { execSync } = require('child_process');
                    execSync(`git config --remove-section remote.origin`, { cwd: repoPath, stdio: 'ignore' });
                } catch (e) {
                    // Ignore if remote.origin doesn't exist
                }
                
                // Remove importedFrom to mark it as a normal repo
                repo.value.importedFrom = null;
                await db.repos.set(repo.id, repo.value);
                convertedCount++;
            }
        }
        
        res.render('import', { error: null, success: `Successfully converted ${convertedCount} mirrored repositories to normal repositories.` });
    } catch (err) {
        res.render('import', { error: `Failed to convert repositories: ${err.message}`, success: null });
    }
});

router.post('/fetch-repos', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { githubToken, githubUsername } = req.body;
    if (!githubToken && !githubUsername) {
        return res.status(400).json({ error: 'GitHub Token or Username is required' });
    }

    try {
        let githubRepos = [];
        if (githubToken) {
            const userResp = await fetch('https://api.github.com/user', {
                headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeGit' }
            });
            if (!userResp.ok) throw new Error('Invalid GitHub Token');
            
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}`, {
                    headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeGit' }
                });
                if (!reposResp.ok) break;
                const pageRepos = await reposResp.json();
                if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
                githubRepos = githubRepos.concat(pageRepos);
                page++;
            }
        } else {
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/users/${githubUsername}/repos?per_page=100&page=${page}`, {
                    headers: { 'User-Agent': 'NodeGit' }
                });
                if (!reposResp.ok) {
                    if (page === 1) throw new Error('Could not find GitHub user or organization');
                    break;
                }
                const pageRepos = await reposResp.json();
                if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
                githubRepos = githubRepos.concat(pageRepos);
                page++;
            }
        }

        const reposList = githubRepos.map(r => ({
            name: r.name,
            description: r.description || '',
            size: r.size,
            private: r.private,
            clone_url: r.clone_url
        }));
        res.json({ repos: reposList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/repo', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { githubToken, targetOwner, repoName, cloneUrl, importType, description } = req.body;
    const currentUser = req.session.user.username;

    let owner = currentUser;
    if (targetOwner && targetOwner !== currentUser) {
        const orgData = await db.orgs.get(targetOwner);
        if (!orgData || orgData.owner !== currentUser) {
            return res.status(403).json({ error: 'Forbidden: Not org owner' });
        }
        owner = targetOwner;
    }

    if (!repoName || !cloneUrl) {
        return res.status(400).json({ error: 'Repository name and clone URL are required' });
    }

    const repoPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
    if (fs.existsSync(repoPath)) {
        return res.status(400).json({ error: `Repository "${repoName}" already exists` });
    }

    let authCloneUrl = cloneUrl;
    if (githubToken) {
        authCloneUrl = authCloneUrl.replace('https://', `https://${githubToken}@`);
    }

    try {
        fs.mkdirSync(repoPath, { recursive: true });
        const git = spawn('git', ['clone', '--mirror', authCloneUrl, repoPath]);

        await new Promise((resolve, reject) => {
            git.on('close', async (code) => {
                if (code === 0) {
                    try {
                        if (importType === 'standalone') {
                            try {
                                const { execSync } = require('child_process');
                                execSync(`git config --remove-section remote.origin`, { cwd: repoPath, stdio: 'ignore' });
                            } catch (e) {
                                // ignore
                            }
                        }

                        await db.repos.set(`${owner}_${repoName}`, {
                            owner,
                            name: repoName,
                            description: description || '',
                            isPrivate: false,
                            createdAt: Date.now(),
                            importedFrom: importType === 'mirror' ? cloneUrl : null
                        });
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Git clone failed with exit code ${code}`));
                }
            });
        });

        res.json({ success: true, message: `Successfully imported "${repoName}"` });
    } catch (err) {
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

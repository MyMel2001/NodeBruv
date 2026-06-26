const express = require('express');
const router = express.Router();
const db = require('../database');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const gitToBruv = require('../services/git-to-bruv');
const bruvApi = require('../services/bruv-api');

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
                headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeBruv' }
            });
            if (!userResp.ok) throw new Error('Invalid GitHub Token');
            
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}`, {
                    headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeBruv' }
                });
                const pageRepos = await reposResp.json();
                if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;
                githubRepos = githubRepos.concat(pageRepos);
                page++;
            }
        } else {
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/users/${githubUsername}/repos?per_page=100&page=${page}`, {
                    headers: { 'User-Agent': 'NodeBruv' }
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

        sendUpdate({ status: 'starting', total: githubRepos.length, message: `Found ${githubRepos.length} repositories. Starting import and conversion to bruv...` });

        let importedCount = 0;
        for (let i = 0; i < githubRepos.length; i++) {
            const repo = githubRepos[i];
            if (repo.private && !githubToken) continue;

            const repoName = repo.name;
            let cloneUrl = repo.clone_url;
            if (githubToken) {
                cloneUrl = cloneUrl.replace('https://', `https://${githubToken}@`);
            }
            
            // Use .bruv suffix for bruv repos
            const repoPath = path.join(__dirname, '..', 'repos', owner, repoName + '.bruv');
            
            // Check both .bruv and legacy .git
            const legacyPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
            if (fs.existsSync(repoPath) || fs.existsSync(legacyPath)) {
                sendUpdate({ status: 'skipping', repo: repoName, message: `Skipping ${repoName} (already exists)` });
                continue;
            }

            sendUpdate({ status: 'cloning', repo: repoName, current: i + 1, total: githubRepos.length, message: `Cloning and converting ${repoName} to bruv...` });

            try {
                // Clone and convert to bruv
                // Clone and convert to bruv, then init via API
                await gitToBruv.cloneAndConvert(cloneUrl, repoPath, {
                    isPrivate: false,
                    author: currentUser,
                });
                // Initialize via bruv API after conversion (best-effort)
                await bruvApi.repoInit(repoPath, {
                    isPrivate: false,
                    author: currentUser,
                }).catch(() => {});
                
                importedCount++;
                await db.repos.set(`${owner}_${repoName}`, {
                    owner,
                    name: repoName,
                    description: repo.description || '',
                    isPrivate: false,
                    createdAt: Date.now(),
                    importedFrom: cloneUrl,
                    format: 'bruv'
                });
                
                sendUpdate({ status: 'imported', repo: repoName, current: i + 1, total: githubRepos.length, message: `Imported ${repoName} as bruv repo` });
            } catch (e) {
                sendUpdate({ status: 'failed', repo: repoName, message: `Failed to import ${repoName}: ${e.message}` });
            }

            if (i < githubRepos.length - 1) {
                await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2000) + 3000));
            }
        }

        clearInterval(heartbeat);
        sendUpdate({ status: 'done', count: importedCount, message: `Successfully imported ${importedCount} repositories as bruv repos.` });
        res.end();

    } catch (err) {
        clearInterval(heartbeat);
        sendUpdate({ status: 'error', error: err.message });
        res.end();
    }
});

router.post('/convert-git-to-bruv', async (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    const owner = req.session.user.username;

    try {
        const allOrgs = await db.orgs.all() || [];
        const userOrgs = allOrgs.filter(o => o.value && o.value.owner === owner).map(o => o.value.name);
        
        const allRepos = await db.repos.all();
        let convertedCount = 0;
        
        for (const repo of allRepos) {
            const repoData = repo.value;
            if (!repoData) continue;
            
            const repoOwner = repoData.owner;
            // Check for legacy .git repo
            const legacyPath = path.join(__dirname, '..', 'repos', repoOwner, repoData.name + '.git');
            const bruvPath = path.join(__dirname, '..', 'repos', repoOwner, repoData.name + '.bruv');
            
            if (fs.existsSync(legacyPath) && gitToBruv.isBareGitRepo(legacyPath) && !gitToBruv.isBruvRepo(legacyPath)) {
                try {
                    await gitToBruv.convertGitToBruv(legacyPath, {
                        isPrivate: repoData.isPrivate,
                        author: owner,
                    });
                    
                    // Update repo format
                    repoData.format = 'bruv';
                    repoData.convertedAt = Date.now();
                    await db.repos.set(`${repoOwner}_${repoData.name}`, repoData);
                    convertedCount++;
                } catch (e) {
                    console.error(`Failed to convert ${repoOwner}/${repoData.name}:`, e.message);
                }
            }
        }
        
        res.render('import', { error: null, success: `Successfully converted ${convertedCount} git repositories to bruv format.`, userOrgs });
    } catch (err) {
        const allOrgs = await db.orgs.all() || [];
        const userOrgs = allOrgs.filter(o => o.value && o.value.owner === owner).map(o => o.value.name);
        res.render('import', { error: `Failed to convert repositories: ${err.message}`, success: null, userOrgs });
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
                headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeBruv' }
            });
            if (!userResp.ok) throw new Error('Invalid GitHub Token');
            
            let page = 1;
            while (true) {
                const reposResp = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}`, {
                    headers: { 'Authorization': `token ${githubToken}`, 'User-Agent': 'NodeBruv' }
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
                    headers: { 'User-Agent': 'NodeBruv' }
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

    const repoPath = path.join(__dirname, '..', 'repos', owner, repoName + '.bruv');
    const legacyPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
    if (fs.existsSync(repoPath) || fs.existsSync(legacyPath)) {
        return res.status(400).json({ error: `Repository "${repoName}" already exists` });
    }

    let authCloneUrl = cloneUrl;
    if (githubToken) {
        authCloneUrl = authCloneUrl.replace('https://', `https://${githubToken}@`);
    }

    try {
        // Clone and convert to bruv
        await gitToBruv.cloneAndConvert(authCloneUrl, repoPath, {
            isPrivate: false,
            author: currentUser,
        });

        await db.repos.set(`${owner}_${repoName}`, {
            owner,
            name: repoName,
            description: description || '',
            isPrivate: false,
            createdAt: Date.now(),
            importedFrom: importType === 'mirror' ? cloneUrl : null,
            format: 'bruv'
        });

        res.json({ success: true, message: `Successfully imported "${repoName}" as bruv repo` });
    } catch (err) {
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

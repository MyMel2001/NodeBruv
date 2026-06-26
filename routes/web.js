const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const svgCaptcha = require('svg-captcha');
const gitToBruv = require('../services/git-to-bruv');
const bruvUtils = require('../services/bruv-utils');
const bruvApi = require('../services/bruv-api');

// Home page
router.get('/', async (req, res) => {
    if (req.session.user) {
        const repos = await db.repos.all() || [];
        const userRepos = repos.filter(r => r.value.owner === req.session.user.username);
        res.render('dashboard', { repos: userRepos });
    } else {
        res.render('index');
    }
});

// Captcha
router.get('/captcha', (req, res) => {
    const captcha = svgCaptcha.create({
        size: 5,
        noise: 3,
        color: true,
        background: '#f6f8fa'
    });
    req.session.captcha = captcha.text.toLowerCase();
    res.type('svg');
    res.status(200).send(captcha.data);
});

// Login
router.get('/login', (req, res) => res.render('login', { error: null }));
router.post('/login', async (req, res) => {
    const { username, password, captcha } = req.body;
    
    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.render('login', { error: 'Invalid captcha' });
    }

    const user = await db.users.get(username);
    
    if (user && user.passwordHash && await bcrypt.compare(password, user.passwordHash)) {
        req.session.user = { username };
        delete req.session.captcha;
        res.redirect('/');
    } else {
        res.render('login', { error: 'Invalid credentials' });
    }
});

// Register
router.get('/register', (req, res) => res.render('register', { error: null }));
router.post('/register', async (req, res) => {
    const { username, password, captcha } = req.body;

    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.render('register', { error: 'Invalid captcha' });
    }

    if (await db.users.get(username) || await db.orgs.get(username)) {
        return res.render('register', { error: 'Username taken' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await db.users.set(username, { username, passwordHash });
    req.session.user = { username };
    delete req.session.captcha;
    res.redirect('/');
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Account Settings
router.get('/settings/profile', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('account_settings', { user: req.session.user, error: req.query.error || null });
});

router.post('/settings/delete-account', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const username = req.session.user.username;
    const { confirm_username, captcha } = req.body;

    if (confirm_username !== username) {
        return res.redirect('/settings/profile?error=Username confirmation does not match');
    }

    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.redirect('/settings/profile?error=Invalid captcha');
    }

    const userRecord = await db.users.get(username);
    if (!userRecord) {
        req.session.destroy();
        return res.redirect('/login?error=Account not found');
    }

    try {
        const deleteRepoCompletely = async (owner, repoName) => {
            const repoId = `${owner}_${repoName}`;
            await db.repos.delete(repoId);
            
            const allPrs = await db.pullRequests.all();
            const repoPrs = allPrs.filter(p => p.id.startsWith(`${owner}_${repoName}_`));
            for (const pr of repoPrs) {
                await db.pullRequests.delete(pr.id);
            }

            const allRuns = await db.ciRuns.all();
            const repoRuns = allRuns.filter(run => run.value && run.value.owner === owner && run.value.repo === repoName);
            for (const run of repoRuns) {
                await db.ciRuns.delete(run.id);
            }

            // Delete bruv repo
            const bruvPath = path.join(__dirname, '..', 'repos', owner, repoName + '.bruv');
            if (fs.existsSync(bruvPath)) {
                fs.rmSync(bruvPath, { recursive: true, force: true });
            }
            // Also delete legacy git repo
            const gitPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
            if (fs.existsSync(gitPath)) {
                fs.rmSync(gitPath, { recursive: true, force: true });
            }
        };

        const allRepos = await db.repos.all();
        const userRepos = allRepos.filter(r => r.value && r.value.owner === username);
        for (const repo of userRepos) {
            await deleteRepoCompletely(username, repo.value.name);
        }

        const allOrgs = await db.orgs.all();
        const userOrgs = allOrgs.filter(o => o.value && o.value.owner === username);
        for (const org of userOrgs) {
            const orgName = org.value.name;
            const orgRepos = allRepos.filter(r => r.value && r.value.owner === orgName);
            for (const repo of orgRepos) {
                await deleteRepoCompletely(orgName, repo.value.name);
            }
            await db.orgs.delete(orgName);
            const orgPath = path.join(__dirname, '..', 'repos', orgName);
            if (fs.existsSync(orgPath)) {
                fs.rmSync(orgPath, { recursive: true, force: true });
            }
        }

        const userPath = path.join(__dirname, '..', 'repos', username);
        if (fs.existsSync(userPath)) {
            fs.rmSync(userPath, { recursive: true, force: true });
        }

        await db.users.delete(username);
        req.session.destroy();
        res.redirect('/');
    } catch (err) {
        console.error('GDPR Deletion Error:', err);
        res.redirect('/settings/profile?error=An error occurred during account deletion');
    }
});

// Search
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    
    const allRepos = await db.repos.all() || [];
    const repos = allRepos
        .map(r => r.value)
        .filter(r => r && r.name && (r.name.toLowerCase().includes(q) || r.owner.toLowerCase().includes(q)))
        .filter(r => !r.isPrivate || (req.session.user && req.session.user.username === r.owner));
        
        
    const allUsers = await db.users.all() || [];
    const users = allUsers
        .map(u => u.value)
        .filter(u => u && u.username && u.username.toLowerCase().includes(q));
        
    const allOrgs = await db.orgs.all() || [];
    const orgs = allOrgs
        .map(o => o.value)
        .filter(o => o && o.name && o.name.toLowerCase().includes(q));
        
    res.render('search', { query: q, repos, users, orgs });
});

// User Profile
router.get('/user/:username', async (req, res) => {
    const username = req.params.username;
    const profileUser = await db.users.get(username);
    if (!profileUser) return res.status(404).send('User not found');
    
    const allRepos = await db.repos.all() || [];
    const repos = allRepos
        .map(r => r.value)
        .filter(r => r && r.owner === profileUser.username)
        .filter(r => !r.isPrivate || (req.session.user && req.session.user.username === r.owner));
        
    let profileReadmeContent = null;
    // Check bruv repo first, then legacy git
    const bruvProfilePath = path.join(__dirname, '..', 'repos', username, username + '.bruv');
    const gitProfilePath = path.join(__dirname, '..', 'repos', username, username + '.git');
    
    let resolvedRepoPath = null;
    let bruvDir = null;
    
    if (fs.existsSync(bruvProfilePath) && gitToBruv.isBruvRepo(bruvProfilePath)) {
        resolvedRepoPath = bruvProfilePath;
        bruvDir = path.join(bruvProfilePath, '.bruv');
    } else if (fs.existsSync(gitProfilePath)) {
        resolvedRepoPath = gitProfilePath;
    }
    
    if (resolvedRepoPath) {
        try {
            let readmeContent = null;
            if (bruvDir) {
                // Read from bruv
                const snap = bruvUtils.resolveHead(bruvDir);
                if (snap && snap.commit && snap.commit.tree) {
                    const files = bruvUtils.flattenTree(bruvDir, snap.commit.tree);
                    const readmeFile = Array.from(files.keys()).find(f => f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme.txt' || f.toLowerCase() === 'readme');
                    if (readmeFile) {
                        readmeContent = bruvUtils.getFileContent(bruvDir, null, readmeFile);
                        if (readmeContent) {
                            profileReadmeContent = readmeContent.toString('utf8');
                        }
                    }
                }
            } else {
                // Fallback to git
                const { execSync } = require('child_process');
                try {
                    let currentBranch = '';
                    try {
                        currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: resolvedRepoPath }).toString().trim();
                        if (currentBranch === 'HEAD') currentBranch = 'main';
                    } catch (e) {
                        const branchList = execSync(`git branch --format='%(refname:short)'`, { cwd: resolvedRepoPath }).toString();
                        const branches = branchList.split('\n').filter(Boolean);
                        currentBranch = branches[0] || 'main';
                    }
                    const lsTree = execSync(`git ls-tree -r ${currentBranch} --name-only`, { cwd: resolvedRepoPath }).toString();
                    const files = lsTree.split('\n').filter(Boolean);
                    const readmeFile = files.find(f => f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme.txt' || f.toLowerCase() === 'readme');
                    if (readmeFile) {
                        profileReadmeContent = execSync(`git show ${currentBranch}:${readmeFile}`, { cwd: resolvedRepoPath }).toString();
                    }
                } catch (err) {
                    // ignore
                }
            }
        } catch (err) {
            // ignore
        }
    }

    res.render('user', { profileUser, repos, profileReadmeContent });
});

// Create Organization (must be before /org/:orgname to avoid wildcard match)
router.get('/org/new', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('new_org', { error: null });
});

router.post('/org/new', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { orgname, captcha } = req.body;
    
    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.render('new_org', { error: 'Invalid captcha' });
    }

    if (await db.users.get(orgname) || await db.orgs.get(orgname)) {
        return res.render('new_org', { error: 'Organization name is already taken' });
    }
    
    await db.orgs.set(orgname, {
        name: orgname,
        owner: req.session.user.username,
        createdAt: Date.now()
    });
    
    delete req.session.captcha;
    res.redirect(`/org/${orgname}`);
});

// Organization Profile
router.get('/org/:orgname', async (req, res) => {
    const orgname = req.params.orgname;
    const orgData = await db.orgs.get(orgname);
    if (!orgData) return res.status(404).send('Organization not found');
    
    const allRepos = await db.repos.all() || [];
    const repos = allRepos
        .map(r => r.value)
        .filter(r => r && r.owner === orgData.name)
        .filter(r => !r.isPrivate || (req.session.user && req.session.user.username === orgData.owner));
        
    res.render('org', { org: orgData, repos });
});

// Organization Settings
router.get('/org/:orgname/settings', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const orgname = req.params.orgname;
    const orgData = await db.orgs.get(orgname);
    
    if (!orgData) return res.status(404).send('Organization not found');
    if (orgData.owner !== req.session.user.username) return res.status(403).send('Forbidden');
    
    res.render('org_settings', { org: orgData, error: req.query.error || null });
});

router.post('/org/:orgname/settings/delete', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const orgname = req.params.orgname;
    const orgData = await db.orgs.get(orgname);
    
    if (!orgData) return res.status(404).send('Organization not found');
    if (orgData.owner !== req.session.user.username) return res.status(403).send('Forbidden');
    
    const { captcha } = req.body;
    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.redirect(`/org/${orgname}/settings?error=Invalid captcha`);
    }
    delete req.session.captcha;
    
    const allRepos = await db.repos.all();
    const orgRepos = allRepos.filter(r => r.value && r.value.owner === orgname);
    
    for (const repo of orgRepos) {
        await db.repos.delete(repo.id);
        const bruvPath = path.join(__dirname, '..', 'repos', orgname, repo.value.name + '.bruv');
        const gitPath = path.join(__dirname, '..', 'repos', orgname, repo.value.name + '.git');
        if (fs.existsSync(bruvPath)) fs.rmSync(bruvPath, { recursive: true, force: true });
        if (fs.existsSync(gitPath)) fs.rmSync(gitPath, { recursive: true, force: true });
    }
    
    const orgPath = path.join(__dirname, '..', 'repos', orgname);
    if (fs.existsSync(orgPath)) {
        fs.rmSync(orgPath, { recursive: true, force: true });
    }
    
    await db.orgs.delete(orgname);
    res.redirect('/');
});

// Create Repo (bruv-native)
router.get('/new', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const allOrgs = await db.orgs.all() || [];
    const userOrgs = allOrgs.filter(o => o.value && o.value.owner === req.session.user.username).map(o => o.value.name);
    res.render('new_repo', { userOrgs });
});

router.post('/new', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { targetOwner, name, isPrivate, description } = req.body;
    
    const currentUser = req.session.user.username;
    let owner = currentUser;
    
    if (targetOwner && targetOwner !== currentUser) {
        const orgData = await db.orgs.get(targetOwner);
        if (!orgData || orgData.owner !== currentUser) {
            return res.status(403).send('Forbidden: Not org owner');
        }
        owner = targetOwner;
    }
    
    // Check both .bruv and legacy .git paths
    const repoPath = path.join(__dirname, '..', 'repos', owner, name + '.bruv');
    const legacyPath = path.join(__dirname, '..', 'repos', owner, name + '.git');
    if (fs.existsSync(repoPath) || fs.existsSync(legacyPath)) {
        return res.status(400).send('Repo already exists');
    }
    
    fs.mkdirSync(repoPath, { recursive: true });

    // Initialize via bruv API server
    try {
        await bruvApi.repoInit(repoPath, {
            isPrivate: isPrivate === 'on',
            author: currentUser,
        });
    } catch (apiErr) {
        // Fallback to local gitToBruv if API server is not running
        console.warn('[bruv-api] repoInit failed, falling back to gitToBruv:', apiErr.message);
        gitToBruv.createNewBruvRepo(repoPath, {
            isPrivate: isPrivate === 'on',
            author: currentUser,
        });
    }
    
    // Save to DB
    const repoData = {
        owner,
        name,
        description: description || '',
        isPrivate: isPrivate === 'on',
        createdAt: Date.now(),
        format: 'bruv'
    };
    await db.repos.set(`${owner}_${name}`, repoData);
    
    res.redirect(`/${owner}/${name}`);
});

// Middleware for repo access
const ensureRepoAccess = async (req, res, next) => {
    const { owner, repo } = req.params;
    const repoData = await db.repos.get(`${owner}_${repo}`);
    if (!repoData) return res.status(404).send('Repo not found');
    
    const orgData = await db.orgs.get(owner);
    req.ownerIsOrg = !!orgData;
    
    if (repoData.isPrivate) {
        let isAuthorized = false;
        if (req.session.user) {
            if (req.session.user.username === owner) {
                isAuthorized = true;
            } else if (orgData && orgData.owner === req.session.user.username) {
                isAuthorized = true;
            }
        }
        if (!isAuthorized) {
            return res.status(404).send('Repo not found');
        }
    }
    
    req.repoData = repoData;
    next();
};

// View Repo
router.get('/:owner/:repo', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { branch } = req.query;
    const repoData = req.repoData;
    
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) return res.status(404).send('Repository data not found on disk');
    
    const bruvDir = path.join(repoPath, '.bruv');
    let files = [];
    let commits = [];
    let snapshots = [];
    let currentBranch = '';
    let readmeContent = null;
    const isBruvRepo = fs.existsSync(bruvDir);
    
    try {
        if (isBruvRepo) {
            // Use bruv utils
            snapshots = bruvUtils.listSnapshots(bruvDir);
            const head = bruvUtils.resolveHead(bruvDir);
            currentBranch = branch || (head ? head.name : snapshots[0] || 'main');
            
            if (head && head.commit && head.commit.tree) {
                const fileMap = bruvUtils.flattenTree(bruvDir, head.commit.tree);
                files = Array.from(fileMap.keys());
                
                // Get commits
                commits = bruvUtils.getCommitHistory(bruvDir, head.commitHash, 4);
                commits = commits.map(c => `${bruvUtils.shortHash(c.hash)} ${c.message.split('\n')[0]}`);
                
                // Read README
                const readmeFile = files.find(f => f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme.txt' || f.toLowerCase() === 'readme');
                if (readmeFile) {
                    const content = bruvUtils.getFileContent(bruvDir, null, readmeFile);
                    if (content) readmeContent = content.toString('utf8');
                }
            }
        } else {
            // Fallback to git
            const { execSync } = require('child_process');
            const branchList = execSync(`git branch --format='%(refname:short)'`, { cwd: repoPath }).toString();
            snapshots = branchList.split('\n').filter(Boolean);
            
            currentBranch = branch || '';
            if (!currentBranch) {
                try {
                    currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: repoPath }).toString().trim();
                    if (currentBranch === 'HEAD') currentBranch = 'main';
                } catch (e) {
                    currentBranch = snapshots[0] || 'main';
                }
            }
            
            const lsTree = execSync(`git ls-tree -r ${currentBranch} --name-only`, { cwd: repoPath }).toString();
            files = lsTree.split('\n').filter(Boolean);
            
            const log = execSync(`git log -n 4 --oneline ${currentBranch}`, { cwd: repoPath }).toString();
            commits = log.split('\n').filter(Boolean);

            const readmeFile = files.find(f => f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme.txt' || f.toLowerCase() === 'readme');
            if (readmeFile) {
                readmeContent = execSync(`git show ${currentBranch}:${readmeFile}`, { cwd: repoPath }).toString();
            }
        }
    } catch (err) {
        commits = ['Empty repository'];
    }
    
    res.render('repo', { repo: repoData, files, commits, snapshots, currentBranch, readmeContent, ownerIsOrg: req.ownerIsOrg });
});

// Fork Repo
router.post('/:owner/:repo/fork', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { repoData } = req;
    
    if (!req.session.user) return res.redirect('/login');
    const currentUser = req.session.user.username;
    
    if (currentUser === owner) {
        return res.status(400).send('Cannot fork your own repository');
    }
    
    const newRepoName = repo;
    const existingRepo = await db.repos.get(`${currentUser}_${newRepoName}`);
    if (existingRepo) {
        return res.status(400).send('You already have a repository with this name');
    }
    
    const newRepoData = {
        owner: currentUser,
        name: newRepoName,
        isPrivate: repoData.isPrivate,
        createdAt: Date.now(),
        forkedFrom: `${owner}/${repo}`,
        format: repoData.format || 'git'
    };
    
    const originalRepoPath = gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!originalRepoPath) return res.status(404).send('Original repository not found');
    
    let newRepoPath = null;
    const originalBruvDir = path.join(originalRepoPath, '.bruv');
    
    try {
        if (fs.existsSync(originalBruvDir)) {
            // Fork bruv repo by copying .bruv/ content
            newRepoPath = path.join(__dirname, '..', 'repos', currentUser, newRepoName + '.bruv');
            fs.mkdirSync(newRepoPath, { recursive: true });
            // Copy just the .bruv directory
            const { execSync } = require('child_process');
            execSync(`cp -r "${originalBruvDir}" "${newRepoPath}/"`);
            newRepoData.format = 'bruv';
        } else {
            // Fallback to git clone
            newRepoPath = path.join(__dirname, '..', 'repos', currentUser, newRepoName + '.git');
            fs.mkdirSync(newRepoPath, { recursive: true });
            const { execSync } = require('child_process');
            execSync(`git clone --bare ${originalRepoPath} ${newRepoPath}`);
            
            // Auto-convert to bruv
            try {
                await gitToBruv.convertGitToBruv(newRepoPath);
                newRepoData.format = 'bruv';
            } catch (e) {
                // Keep as git if conversion fails
            }
        }
        
        await db.repos.set(`${currentUser}_${newRepoName}`, newRepoData);
        res.redirect(`/${currentUser}/${newRepoName}`);
    } catch (e) {
        if (newRepoPath && fs.existsSync(newRepoPath)) {
            fs.rmSync(newRepoPath, { recursive: true, force: true });
        }
        return res.status(500).send('Error forking repository: ' + e.message);
    }
});

// Helper to check if user is repo owner
const isRepoOwner = async (req, repoData) => {
    if (!req.session.user) return false;
    if (req.session.user.username === repoData.owner) return true;
    const orgData = await db.orgs.get(repoData.owner);
    if (orgData && orgData.owner === req.session.user.username) return true;
    return false;
};

// Settings Routes
router.get('/:owner/:repo/settings', ensureRepoAccess, async (req, res) => {
    const { repoData } = req;
    if (!(await isRepoOwner(req, repoData))) {
        return res.status(403).send('Forbidden');
    }
    res.render('repo_settings', { repo: repoData, error: req.query.error || null, ownerIsOrg: req.ownerIsOrg });
});

router.post('/:owner/:repo/settings/privacy', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { repoData } = req;
    if (!(await isRepoOwner(req, repoData))) return res.status(403).send('Forbidden');
    
    repoData.isPrivate = req.body.isPrivate === 'on';
    await db.repos.set(`${owner}_${repo}`, repoData);
    res.redirect(`/${owner}/${repo}/settings`);
});

router.post('/:owner/:repo/settings/metadata', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { repoData } = req;
    if (!(await isRepoOwner(req, repoData))) return res.status(403).send('Forbidden');
    
    repoData.description = req.body.description || '';
    await db.repos.set(`${owner}_${repo}`, repoData);
    res.redirect(`/${owner}/${repo}/settings`);
});

router.post('/:owner/:repo/settings/delete', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { repoData } = req;
    if (!(await isRepoOwner(req, repoData))) return res.status(403).send('Forbidden');
    
    await db.repos.delete(`${owner}_${repo}`);
    // Delete both bruv and legacy git repos
    const bruvPath = path.join(__dirname, '..', 'repos', owner, repo + '.bruv');
    const gitPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    if (fs.existsSync(bruvPath)) fs.rmSync(bruvPath, { recursive: true, force: true });
    if (fs.existsSync(gitPath)) fs.rmSync(gitPath, { recursive: true, force: true });
    res.redirect('/');
});

router.post('/:owner/:repo/settings/transfer', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { repoData } = req;
    if (!(await isRepoOwner(req, repoData))) return res.status(403).send('Forbidden');
    
    const { newOwner, captcha } = req.body;
    
    if (!captcha || captcha.toLowerCase() !== req.session.captcha) {
        return res.redirect(`/${owner}/${repo}/settings?error=Invalid captcha`);
    }
    delete req.session.captcha;
    
    if (newOwner === owner) {
        return res.redirect(`/${owner}/${repo}/settings?error=Cannot transfer to the same owner`);
    }
    
    const userExists = await db.users.get(newOwner);
    const orgExists = await db.orgs.get(newOwner);
    
    if (!userExists && !orgExists) {
        return res.redirect(`/${owner}/${repo}/settings?error=User or Organization not found`);
    }
    
    if (orgExists && orgExists.owner !== req.session.user.username) {
        return res.redirect(`/${owner}/${repo}/settings?error=You can only transfer to organizations you own`);
    }
    
    const existingRepo = await db.repos.get(`${newOwner}_${repo}`);
    if (existingRepo) {
        return res.redirect(`/${owner}/${repo}/settings?error=Target owner already has a repository with this name`);
    }
    
    // DB Migration
    await db.repos.delete(`${owner}_${repo}`);
    repoData.owner = newOwner;
    await db.repos.set(`${newOwner}_${repo}`, repoData);
    
    // FS Migration - move both bruv and git repos
    const targetDir = path.join(__dirname, '..', 'repos', newOwner);
    fs.mkdirSync(targetDir, { recursive: true });
    
    const oldBruvPath = path.join(__dirname, '..', 'repos', owner, repo + '.bruv');
    const newBruvPath = path.join(targetDir, repo + '.bruv');
    if (fs.existsSync(oldBruvPath)) {
        fs.renameSync(oldBruvPath, newBruvPath);
    }
    
    const oldGitPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const newGitPath = path.join(targetDir, repo + '.git');
    if (fs.existsSync(oldGitPath)) {
        fs.renameSync(oldGitPath, newGitPath);
    }
    
    res.redirect(`/${newOwner}/${repo}`);
});

// PR Routes
router.get('/:owner/:repo/pulls', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const allPulls = await db.pullRequests.all();
    const pulls = allPulls.filter(p => p.id.startsWith(`${owner}_${repo}_`));
    res.render('pulls', { owner, repo, pulls });
});

router.get('/:owner/:repo/pull/new', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) return res.status(404).send('Repo not found');
    
    const bruvDir = path.join(repoPath, '.bruv');
    let branches = [];
    
    if (fs.existsSync(bruvDir)) {
        branches = bruvUtils.listSnapshots(bruvDir);
    } else {
        const { execSync } = require('child_process');
        try {
            branches = execSync(`git branch --format='%(refname:short)'`, { cwd: repoPath }).toString().split('\n').filter(Boolean);
        } catch (e) {}
    }
    
    res.render('new_pull', { owner, repo, branches });
});

router.post('/:owner/:repo/pull/new', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { title, base, head } = req.body;
    const id = `${owner}_${repo}_${Date.now()}`;
    const author = req.session.user.username;

    // Try creating PR via bruv API server
    try {
        const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
        if (repoPath) {
            const result = await bruvApi.prCreate(repoPath, {
                title,
                sourceSnapshot: head,
                targetSnapshot: base,
                author,
            });
            // Use the bruv-generated full hash as the PR id
            const bruvId = result.fullHash ? result.fullHash.slice(0, 7) : id;
            await db.pullRequests.set(bruvId, {
                id: bruvId,
                fullHash: result.fullHash,
                owner, repo, title, base, head,
                status: 'open',
                author,
                createdAt: Date.now()
            });
            res.redirect(`/${owner}/${repo}/pulls`);
            return;
        }
    } catch (apiErr) {
        console.warn('[bruv-api] prCreate failed, falling back to DB-only:', apiErr.message);
    }

    // Fallback: DB-only PR
    await db.pullRequests.set(id, {
        id, owner, repo, title, base, head,
        status: 'open',
        author,
        createdAt: Date.now()
    });
    res.redirect(`/${owner}/${repo}/pulls`);
});

router.get('/:owner/:repo/pull/:id', ensureRepoAccess, async (req, res) => {
    const { owner, repo, id } = req.params;
    const pr = await db.pullRequests.get(id);
    if (!pr) return res.status(404).send('PR not found');

    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) return res.status(404).send('Repo not found');
    
    let diff = '';
    try {
        const { execSync } = require('child_process');
        diff = execSync(`git diff ${pr.base}..${pr.head}`, { cwd: repoPath }).toString();
    } catch (e) {
        diff = 'Error generating diff: ' + e.message;
    }
    
    res.render('pull_detail', { pr, diff });
});

router.post('/:owner/:repo/pull/:id/merge', ensureRepoAccess, async (req, res) => {
    const { owner, repo, id } = req.params;
    const pr = await db.pullRequests.get(id);
    if (!pr) return res.status(404).send('PR not found');

    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) return res.status(404).send('Repo not found');

    const bruvDir = path.join(repoPath, '.bruv');
    const isBruvRepo = fs.existsSync(bruvDir);
    
    try {
        if (isBruvRepo) {
            // Use bruv API for native merge (conflict-free union merge by default)
            try {
                await bruvApi.prMerge(repoPath, pr.fullHash || id, pr.author, 'union');
            } catch (apiErr) {
                // Fallback: try snapshots merge directly
                console.warn('[bruv-api] prMerge failed, trying snapshots merge:', apiErr.message);
                await bruvApi.snapshotsMerge(repoPath, [pr.base, pr.head], pr.author, `Merge PR #${id}: ${pr.title}`);
            }
            
            // Auto-convert if not already bruv
            if (!fs.existsSync(bruvDir)) {
                try { await gitToBruv.convertGitToBruv(repoPath); } catch (e) {}
            }
        } else {
            // Legacy git merge fallback
            const { execSync } = require('child_process');
            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bruv-merge-'));
            execSync(`git clone ${repoPath} ${tempDir}`);
            execSync(`git checkout ${pr.base}`, { cwd: tempDir });
            execSync(`git merge ${pr.head} --no-ff -m "Merge pull request #${id}: ${pr.title}"`, { cwd: tempDir });
            execSync(`git push origin ${pr.base}`, { cwd: tempDir });
            
            // Auto-convert to bruv after merge
            if (!fs.existsSync(bruvDir)) {
                try { await gitToBruv.convertGitToBruv(repoPath); } catch (e) {}
            }
        }
        
        pr.status = 'merged';
        pr.mergedAt = Date.now();
        await db.pullRequests.set(id, pr);
        
        res.redirect(`/${owner}/${repo}/pull/${id}`);
    } catch (err) {
        res.status(500).send('Merge conflict or error: ' + err.message);
    }
});

// Releases
router.get('/:owner/:repo/releases', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    let releases = [];
    
    if (repoPath) {
        const bruvDir = path.join(repoPath, '.bruv');
        if (fs.existsSync(bruvDir)) {
            // Try bruv API first
            try {
                const apiTags = await bruvApi.tagsList(repoPath);
                releases = apiTags.map(t => ({
                    tag: t.name,
                    name: t.name,
                    body: t.message || 'Release ' + t.name,
                    createdAt: t.createdAt ? new Date(t.createdAt) : new Date()
                }));
            } catch (apiErr) {
                console.warn('[bruv-api] tagsList failed, falling back:', apiErr.message);
                const tags = bruvUtils.listTags(bruvDir);
                releases = tags.map(tag => ({
                    tag,
                    name: tag,
                    body: 'Release ' + tag,
                    createdAt: new Date()
                }));
            }
        } else {
            try {
                const { execSync } = require('child_process');
                const tags = execSync(`git tag -l`, { cwd: repoPath }).toString().split('\n').filter(Boolean);
                releases = tags.map(tag => ({
                    tag,
                    name: tag,
                    body: 'Release ' + tag,
                    createdAt: new Date()
                }));
            } catch (e) {}
        }
    }
    
    res.render('releases', { owner, repo, releases });
});

router.get('/:owner/:repo/releases/new', ensureRepoAccess, (req, res) => {
    const { owner, repo } = req.params;
    res.render('new_release', { owner, repo });
});

router.post('/:owner/:repo/releases/new', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { tag, title, body } = req.body;
    const repoPath = await gitToBruv.resolveRepoPath(path.join(__dirname, '..', 'repos'), owner, repo);
    if (!repoPath) return res.status(404).send('Repo not found');
    
    const bruvDir = path.join(repoPath, '.bruv');
    const isBruvRepo = fs.existsSync(bruvDir);
    
    try {
        if (isBruvRepo) {
            // Use bruv API to create a tag natively
            try {
                await bruvApi.tagCreate(repoPath, tag, `${title}\n\n${body}`, req.session.user.username);
            } catch (apiErr) {
                console.warn('[bruv-api] tagCreate failed:', apiErr.message);
                throw apiErr;
            }
        } else {
            // Legacy git tag
            const { execSync } = require('child_process');
            execSync(`git tag -a ${tag} -m "${title}\n\n${body}"`, { cwd: repoPath });
            
            // Auto-convert to bruv after tag if needed
            if (!fs.existsSync(bruvDir)) {
                try {
                    await gitToBruv.convertGitToBruv(repoPath);
                } catch (e) {}
            }
        }
        
        res.redirect(`/${owner}/${repo}/releases`);
    } catch (err) {
        res.status(500).send('Error creating release: ' + err.message);
    }
});

module.exports = router;

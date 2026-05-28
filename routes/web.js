const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const svgCaptcha = require('svg-captcha');

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
        delete req.session.captcha; // Clear captcha after success
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
    delete req.session.captcha; // Clear captcha after success
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
        // Function to delete a repo and its data
        const deleteRepoCompletely = async (owner, repoName) => {
            const repoId = `${owner}_${repoName}`;
            await db.repos.delete(repoId);
            
            // Delete PRs
            const allPrs = await db.pullRequests.all();
            const repoPrs = allPrs.filter(p => p.id.startsWith(`${owner}_${repoName}_`));
            for (const pr of repoPrs) {
                await db.pullRequests.delete(pr.id);
            }

            // Delete CI Runs
            const allRuns = await db.ciRuns.all();
            const repoRuns = allRuns.filter(run => run.value && run.value.owner === owner && run.value.repo === repoName);
            for (const run of repoRuns) {
                await db.ciRuns.delete(run.id);
            }

            // Delete from disk
            const repoPath = path.join(__dirname, '..', 'repos', owner, repoName + '.git');
            if (fs.existsSync(repoPath)) {
                fs.rmSync(repoPath, { recursive: true, force: true });
            }
        };

        // 1. Delete user's personal repos
        const allRepos = await db.repos.all();
        const userRepos = allRepos.filter(r => r.value && r.value.owner === username);
        for (const repo of userRepos) {
            await deleteRepoCompletely(username, repo.value.name);
        }

        // 2. Delete user's organizations and their repos
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

        // 3. Delete user directory
        const userPath = path.join(__dirname, '..', 'repos', username);
        if (fs.existsSync(userPath)) {
            fs.rmSync(userPath, { recursive: true, force: true });
        }

        // 4. Delete user record
        await db.users.delete(username);

        // 5. Logout
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
    const profileRepoPath = path.join(__dirname, '..', 'repos', username, username + '.git');
    if (fs.existsSync(profileRepoPath)) {
        try {
            let currentBranch = '';
            try {
                currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: profileRepoPath }).toString().trim();
                if (currentBranch === 'HEAD') currentBranch = 'main';
            } catch (e) {
                const branchList = execSync(`git branch --format='%(refname:short)'`, { cwd: profileRepoPath }).toString();
                const branches = branchList.split('\n').filter(Boolean);
                currentBranch = branches[0] || 'main';
            }
            const lsTree = execSync(`git ls-tree -r ${currentBranch} --name-only`, { cwd: profileRepoPath }).toString();
            const files = lsTree.split('\n').filter(Boolean);
            const readmeFile = files.find(f => f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme.txt' || f.toLowerCase() === 'readme');
            if (readmeFile) {
                profileReadmeContent = execSync(`git show ${currentBranch}:${readmeFile}`, { cwd: profileRepoPath }).toString();
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
    
    delete req.session.captcha; // clear captcha
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
    
    // Delete all repos owned by the org
    const allRepos = await db.repos.all();
    const orgRepos = allRepos.filter(r => r.value && r.value.owner === orgname);
    
    for (const repo of orgRepos) {
        await db.repos.delete(repo.id);
        const repoPath = path.join(__dirname, '..', 'repos', orgname, repo.value.name + '.git');
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }
    }
    
    // Delete the org directory
    const orgPath = path.join(__dirname, '..', 'repos', orgname);
    if (fs.existsSync(orgPath)) {
        fs.rmSync(orgPath, { recursive: true, force: true });
    }
    
    // Delete the org record
    await db.orgs.delete(orgname);
    
    res.redirect('/');
});

// Create Repo
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
    
    // Create git repo on disk
    const repoPath = path.join(__dirname, '..', 'repos', owner, name + '.git');
    if (fs.existsSync(repoPath)) {
        return res.status(400).send('Repo already exists');
    }
    fs.mkdirSync(repoPath, { recursive: true });
    execSync(`git init --bare`, { cwd: repoPath });
    
    // Save to DB
    const repoData = {
        owner,
        name,
        description: description || '',
        isPrivate: isPrivate === 'on',
        createdAt: Date.now()
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
            return res.status(404).send('Repo not found'); // return 404 instead of 403 to hide existence
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
    
    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    let files = [];
    let commits = [];
    let branches = [];
    let currentBranch = '';
    
    let readmeContent = null;
    
    try {
        const branchList = execSync(`git branch --format='%(refname:short)'`, { cwd: repoPath }).toString();
        branches = branchList.split('\n').filter(Boolean);
        
        currentBranch = branch || '';
        if (!currentBranch) {
            try {
                currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: repoPath }).toString().trim();
                if (currentBranch === 'HEAD') currentBranch = 'main';
            } catch (e) {
                currentBranch = branches[0] || 'main';
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
    } catch (err) {
        commits = ['Empty repository'];
    }
    
    res.render('repo', { repo: repoData, files, commits, branches, currentBranch, readmeContent, ownerIsOrg: req.ownerIsOrg });
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
    
    // Check if fork already exists
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
        forkedFrom: `${owner}/${repo}`
    };
    
    const originalRepoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const newRepoPath = path.join(__dirname, '..', 'repos', currentUser, newRepoName + '.git');
    
    try {
        fs.mkdirSync(newRepoPath, { recursive: true });
        execSync(`git clone --bare ${originalRepoPath} ${newRepoPath}`);
        await db.repos.set(`${currentUser}_${newRepoName}`, newRepoData);
        res.redirect(`/${currentUser}/${newRepoName}`);
    } catch (e) {
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
    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true });
    }
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
    
    // If transferring to an org, verify the current user owns that org
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
    
    // FS Migration
    const targetDir = path.join(__dirname, '..', 'repos', newOwner);
    fs.mkdirSync(targetDir, { recursive: true });
    
    const oldPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const newPath = path.join(targetDir, repo + '.git');
    if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
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
    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const branches = execSync(`git branch --format='%(refname:short)'`, { cwd: repoPath }).toString().split('\n').filter(Boolean);
    res.render('new_pull', { owner, repo, branches });
});

router.post('/:owner/:repo/pull/new', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { title, base, head } = req.body;
    const id = `${owner}_${repo}_${Date.now()}`;
    await db.pullRequests.set(id, {
        id, owner, repo, title, base, head, 
        status: 'open', 
        author: req.session.user.username,
        createdAt: Date.now()
    });
    res.redirect(`/${owner}/${repo}/pulls`);
});

router.get('/:owner/:repo/pull/:id', ensureRepoAccess, async (req, res) => {
    const { owner, repo, id } = req.params;
    const pr = await db.pullRequests.get(id);
    if (!pr) return res.status(404).send('PR not found');

    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    const diff = execSync(`git diff ${pr.base}..${pr.head}`, { cwd: repoPath }).toString();
    
    res.render('pull_detail', { pr, diff });
});

router.post('/:owner/:repo/pull/:id/merge', ensureRepoAccess, async (req, res) => {
    const { owner, repo, id } = req.params;
    const pr = await db.pullRequests.get(id);
    if (!pr) return res.status(404).send('PR not found');

    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    try {
        // Simple merge strategy: checkout base, merge head, push back
        // Since it's a bare repo, we need a temporary worktree
        const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'git-merge-'));
        execSync(`git clone ${repoPath} ${tempDir}`);
        execSync(`git checkout ${pr.base}`, { cwd: tempDir });
        execSync(`git merge ${pr.head} --no-ff -m "Merge pull request #${id}: ${pr.title}"`, { cwd: tempDir });
        execSync(`git push origin ${pr.base}`, { cwd: tempDir });
        
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
    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    let releases = [];
    try {
        // List tags
        const tags = execSync(`git tag -l`, { cwd: repoPath }).toString().split('\n').filter(Boolean);
        releases = tags.map(tag => ({
            tag,
            name: tag,
            body: 'Release ' + tag,
            createdAt: new Date()
        }));
    } catch (e) {}
    res.render('releases', { owner, repo, releases });
});

router.get('/:owner/:repo/releases/new', ensureRepoAccess, (req, res) => {
    const { owner, repo } = req.params;
    res.render('new_release', { owner, repo });
});

router.post('/:owner/:repo/releases/new', ensureRepoAccess, async (req, res) => {
    const { owner, repo } = req.params;
    const { tag, title, body } = req.body;
    const repoPath = path.join(__dirname, '..', 'repos', owner, repo + '.git');
    try {
        execSync(`git tag -a ${tag} -m "${title}\n\n${body}"`, { cwd: repoPath });
        res.redirect(`/${owner}/${repo}/releases`);
    } catch (err) {
        res.status(500).send('Error creating release: ' + err.message);
    }
});

module.exports = router;

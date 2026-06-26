/**
 * bruv API Client
 *
 * Wraps all calls to the bruv REST API server (port 2658).
 * Replaces the old git/bruv-utils direct fs approach for write operations.
 *
 * API Base: http://localhost:2658/api/*
 *
 * Reference: for-reference/bruv/src/api/server.js
 */

const BRUV_API_URL = process.env.BRUV_API_URL || 'http://localhost:2658';
const BRUV_API_BASE = BRUV_API_URL.replace(/\/$/, '') + '/api';

/**
 * Low-level fetch wrapper for the bruv API.
 * Sets auth headers if a token is available, handles errors.
 */
async function bruvFetch(repoPath, method, endpoint, body = null) {
  const url = `${BRUV_API_BASE}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };

  if (repoPath) {
    headers['X-Bruv-Repo-Path'] = repoPath;
  }

  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `bruv API error: ${res.status}`);
    }
    return json;
  } catch (err) {
    if (err.message.includes('bruv API error')) throw err;
    throw new Error(`bruv API unreachable at ${BRUV_API_URL}: ${err.message}`);
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

async function health() {
  return bruvFetch(null, 'GET', '/health');
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function register(username, password, email) {
  return bruvFetch(null, 'POST', '/auth/register', { username, password, email });
}

async function login(username, password) {
  return bruvFetch(null, 'POST', '/auth/login', { username, password });
}

async function authMe(token) {
  const url = `${BRUV_API_BASE}/auth/me`;
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetch(url, { headers });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Auth failed');
  return json;
}

// ─── Repository ──────────────────────────────────────────────────────────────

async function repoInfo(repoPath) {
  return bruvFetch(repoPath, 'GET', '/repo/info');
}

async function repoInit(repoPath, opts = {}) {
  return bruvFetch(repoPath, 'POST', '/repo/init', {
    private: opts.isPrivate || false,
    remote: opts.remote || null,
    author: opts.author || 'nodebruv',
    email: opts.email || '',
  });
}

async function repoStatus(repoPath) {
  return bruvFetch(repoPath, 'GET', '/repo/status');
}

// ─── Staging / Commits ───────────────────────────────────────────────────────

async function repoAdd(repoPath, files, danger = false) {
  return bruvFetch(repoPath, 'POST', '/repo/add', { files, danger });
}

async function repoCommit(repoPath, message, author) {
  return bruvFetch(repoPath, 'POST', '/repo/commit', { message, author });
}

async function repoLog(repoPath, count = 50) {
  return bruvFetch(repoPath, 'GET', `/repo/log?count=${count}`);
}

async function repoDiff(repoPath) {
  return bruvFetch(repoPath, 'GET', '/repo/diff');
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

async function snapshotsList(repoPath) {
  return bruvFetch(repoPath, 'GET', '/snapshots');
}

async function snapshotCreate(repoPath, name, message, author) {
  return bruvFetch(repoPath, 'POST', '/snapshots', { name, message, author });
}

async function snapshotSwitch(repoPath, name) {
  return bruvFetch(repoPath, 'POST', '/snapshots/switch', { name });
}

async function snapshotDelete(repoPath, name) {
  return bruvFetch(repoPath, 'DELETE', `/snapshots/${encodeURIComponent(name)}`);
}

async function snapshotsMerge(repoPath, sources, author, message, strategy) {
  return bruvFetch(repoPath, 'POST', '/snapshots/merge', {
    sources,
    author: author || 'nodebruv',
    message: message || '',
    strategy: strategy || 'union',
  });
}

async function snapshotShare(repoPath, name, username) {
  return bruvFetch(repoPath, 'POST', `/snapshots/${encodeURIComponent(name)}/share`, { username });
}

async function snapshotUnshare(repoPath, name, username) {
  return bruvFetch(repoPath, 'POST', `/snapshots/${encodeURIComponent(name)}/unshare`, { username });
}

// ─── Tags ────────────────────────────────────────────────────────────────────

async function tagsList(repoPath) {
  return bruvFetch(repoPath, 'GET', '/tags');
}

async function tagCreate(repoPath, name, message, author) {
  return bruvFetch(repoPath, 'POST', '/tags', { name, message, author });
}

// ─── Pull Requests ───────────────────────────────────────────────────────────

async function prsList(repoPath, status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return bruvFetch(repoPath, 'GET', '/prs' + qs);
}

async function prCreate(repoPath, opts = {}) {
  return bruvFetch(repoPath, 'POST', '/prs', {
    title: opts.title,
    description: opts.description || '',
    sourceSnapshot: opts.sourceSnapshot,
    targetSnapshot: opts.targetSnapshot,
    author: opts.author || 'nodebruv',
    isPrivate: opts.isPrivate || false,
    reviewers: opts.reviewers || [],
  });
}

async function prGet(repoPath, id) {
  return bruvFetch(repoPath, 'GET', `/prs/${encodeURIComponent(id)}`);
}

async function prMerge(repoPath, id, author, strategy, choices) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/merge`, {
    author: author || 'nodebruv',
    strategy: strategy || 'union',
    choices,
  });
}

async function prClose(repoPath, id, closedBy) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/close`, {
    closedBy: closedBy || 'nodebruv',
  });
}

async function prReopen(repoPath, id) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/reopen`);
}

async function prComment(repoPath, id, author, body) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/comment`, {
    author: author || 'nodebruv',
    body,
  });
}

async function prApprove(repoPath, id, approver) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/approve`, {
    approver: approver || 'nodebruv',
  });
}

async function prShare(repoPath, id, username) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/share`, { username });
}

async function prUnshare(repoPath, id, username) {
  return bruvFetch(repoPath, 'POST', `/prs/${encodeURIComponent(id)}/unshare`, { username });
}

// ─── Remotes ─────────────────────────────────────────────────────────────────

async function remotesList(repoPath) {
  return bruvFetch(repoPath, 'GET', '/remotes');
}

async function remoteAdd(repoPath, name, url) {
  return bruvFetch(repoPath, 'POST', '/remotes', { name, url });
}

async function remoteRemove(repoPath, name) {
  return bruvFetch(repoPath, 'DELETE', `/remotes/${encodeURIComponent(name)}`);
}

// ─── Push / Pull ─────────────────────────────────────────────────────────────

async function repoPush(repoPath, opts = {}) {
  return bruvFetch(repoPath, 'POST', '/repo/push', opts);
}

async function repoPull(repoPath, opts = {}) {
  return bruvFetch(repoPath, 'POST', '/repo/pull', opts);
}

// ─── Config ──────────────────────────────────────────────────────────────────

async function configGet() {
  return bruvFetch(null, 'GET', '/config');
}

async function configSet(repoPath, key, value) {
  return bruvFetch(repoPath, 'POST', '/config', { key, value });
}

// ─── Security ────────────────────────────────────────────────────────────────

async function securityScan(repoPath, files, useAI = false) {
  return bruvFetch(repoPath, 'POST', '/security/scan', { files, useAI });
}

module.exports = {
  BRUV_API_URL,
  BRUV_API_BASE,
  // Health
  health,
  // Auth
  register,
  login,
  authMe,
  // Repo
  repoInfo,
  repoInit,
  repoStatus,
  // Staging / Commits
  repoAdd,
  repoCommit,
  repoLog,
  repoDiff,
  // Snapshots
  snapshotsList,
  snapshotCreate,
  snapshotSwitch,
  snapshotDelete,
  snapshotsMerge,
  snapshotShare,
  snapshotUnshare,
  // Tags
  tagsList,
  tagCreate,
  // PRs
  prsList,
  prCreate,
  prGet,
  prMerge,
  prClose,
  prReopen,
  prComment,
  prApprove,
  prShare,
  prUnshare,
  // Remotes
  remotesList,
  remoteAdd,
  remoteRemove,
  // Push / Pull
  repoPush,
  repoPull,
  // Config
  configGet,
  configSet,
  // Security
  securityScan,
};

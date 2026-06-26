const { QuickDB } = require('quick.db');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'default-secret-key-32-chars-long!!'; // 32 chars
const IV_LENGTH = 16;

function encrypt(text) {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// Initialize QuickDB instances for different collections
const dbPath = path.join(__dirname, 'data.sqlite');
const db = new QuickDB({ filePath: dbPath });

// Wrapper to automatically encrypt/decrypt
const wrapTable = (table) => ({
    get: async (key) => {
        const val = await table.get(key);
        if (typeof val === 'string' && val.includes(':')) {
            try { return JSON.parse(decrypt(val)); } catch(e) { return val; }
        }
        return val;
    },
    set: async (key, val) => {
        const encrypted = encrypt(JSON.stringify(val));
        return await table.set(key, encrypted);
    },
    all: async () => {
        const all = await table.all();
        return all.map(item => {
            if (typeof item.value === 'string' && item.value.includes(':')) {
                try { item.value = JSON.parse(decrypt(item.value)); } catch(e) {}
            }
            return item;
        });
    },
    delete: (key) => table.delete(key)
});

const users = wrapTable(db.table('users'));
const orgs = wrapTable(db.table('orgs'));
const repos = wrapTable(db.table('repos'));
const pullRequests = wrapTable(db.table('pull_requests'));
const ciRuns = wrapTable(db.table('ci_runs'));

module.exports = {
    users,
    orgs,
    repos,
    pullRequests,
    ciRuns
};

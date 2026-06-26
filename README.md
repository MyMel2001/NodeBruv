# NodeBruv 🚀

A professional-grade, self-hosted web frontend for **[bruv](https://github.com/mymel2001/bruv)** — the source control tool that's easier than git. NodeBruv provides a GitHub-like interface for managing bruv repositories, pull requests, and releases.

> **bruv** features native PRs, private repos, snapshots (not branches), tags, and AI-powered merging. NodeBruv is the web frontend for hosting bruv repositories, with **automatic git-to-bruv conversion** for existing bare git repos.

## ✨ Features

- **Bruv-Native Hosting**: Create and manage bruv repositories on your own server. Repos use content-addressable storage (SHA-256 hashing).
- **Auto-Convert Git Repos**: Existing bare `.git` repos are automatically detected and converted to bruv (`.bruv/`) on startup, import, push, and merge.
- **Snapshot Workflow**: bruv uses snapshots instead of branches — union merge by default with no conflicts.
- **Organizations**: Create organizations to group repositories. CAPTCHA-protected creation.
- **Repository Transfer**: Transfer repos between accounts/orgs with CAPTCHA verification.
- **Forking**: Fork any public repo with a single click, preserving all history.
- **Private Repositories**: Private repos return 404 to unauthorized users. Push/pull requires Basic Auth.
- **Pull Requests**: Full PR workflow including web-based diffing and merging.
- **User Profiles & Search**: Global search filters repos, users, and orgs.
- **Profile READMEs**: Create a `username/username` repo with README.md for a profile card.
- **Remote Import**: Bulk or selective import from GitHub — auto-converted to bruv.
- **NodeBruv Pages**: Host static sites from repos. Custom domain (CNAME) support.
- **Security**: CAPTCHA, DB encryption, HTTPS, secret scanning, dependency scanning.
- **CI/CD**: GitHub Actions-compatible runner (Docker-ready).
- **Themeable UI**: Light mode (GitHub-esque) + Lime-on-Black dark mode.
- **Release Management**: Create and view tags/releases.

## 🛠️ Tech Stack

- **Backend**: Node.js, Express
- **Database**: SQLite (via `better-sqlite3`, `quick.db`)
- **Templating**: EJS
- **Styling**: Vanilla CSS
- **VCS**: bruv-native content-addressable objects, with git backward compatibility

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- (Optional) Git for legacy repo compatibility

### Installation

```bash
git clone https://github.com/nodemixaholic/NodeBruv.git
cd NodeBruv
npm install
cp .env.example .env  # Edit as needed
npm run dev
```

Server runs at `http://localhost:3000` (configurable via `PORT` in `.env`).

## ⚙️ Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `SESSION_SECRET` | Session secret | `super-secret-bruv-frontend` |
| `DB_ENCRYPTION_KEY` | 32-char AES-256 key | (required) |
| `MAIN_DOMAIN` | Main domain | `localhost` |
| `PAGES_DOMAIN` | Pages CNAME domain | `pages.nodebruv.com` |
| `BRUV_BLOCK_ENV_FILES` | Block credential files | `true` |
| `BRUV_BLOCKED_PATTERNS` | Blocked file patterns | `.env,.env.*,...` |

## 🔄 Git → Bruv Auto-Conversion

NodeBruv converts existing bare git repos to bruv:

- **Startup**: All `.git` bare repos in `repos/` are scanned and converted
- **Import**: GitHub-imported repos cloned then converted
- **Push**: After git push, repo auto-converted
- **Merge**: After PR merge, repo auto-converted
- **Manual**: `/import/convert-git-to-bruv` endpoint for batch conversion

Git objects remain intact alongside `.bruv/` for backward compatibility.

## 🔒 Security

- **CAPTCHA**: SVG CAPTCHA on registration, login, org creation, repo transfer
- **HTTPS**: Drop `key.pem` + `cert.pem` in root for TLS
- **bruv Security**: `.env` and credential files blocked by default (like bruv's `--danger` flag policy)

## 📜 License

See [`LICENSE`](LICENSE).

---

Built with ❤️ by the NodeBruv contributors.

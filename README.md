# NodeGit 🚀

A professional-grade, self-hosted Git frontend built with Node.js. NodeGit provides a streamlined interface for managing repositories, pull requests, and releases, with a strong focus on security and developer experience.

## ✨ Features

- **Git Hosting**: Create and manage bare Git repositories on your own server.
- **Organizations**: Create organizations to group repositories under a shared namespace. Organization names are protected against user namespace collisions. Creation is CAPTCHA-protected to prevent bot abuse.
- **Repository Transfer**: Securely transfer repositories between your personal account and your organizations (or to other users) with CAPTCHA verification. Validates that destination accounts exist and prevents naming collisions.
- **Forking**: Fork any public repository into your own account with a single click, preserving all history and branches.
- **Private Repositories**: Mark repositories as private to restrict access. Private repos return 404 to unauthorized users to prevent enumeration. Git operations on private repos require Basic Authentication.
- **Pull Requests**: Full PR workflow including web-based diffing and merging.
- **User Profiles & Search**: View any user's or organization's public repositories. A global search bar filters repositories, users, and organizations by name.
- **User Profile READMEs**: Create a repository with the same name as your username (e.g., `alice/alice`) containing a `README.md` to render a custom description card on your user profile page.
- **Repository Descriptions**: Assign descriptions to repositories at creation or in settings, displayed across dashboards, profiles, organizations, and search results.
- **Clean Explorer & Compact History**:
  - File explorer lists the first 6 files by default with a "Show more" button, while always prioritizing and displaying `README` and `LICENSE` files.
  - Branch view displays a compact history showing only the last 4 commits.
- **GitHub Import**: Import repositories interactively from GitHub:
  - **Bulk Mirror Import**: Mirror all repositories from a user or organization in one go.
  - **Selective Import**: Interactively fetch GitHub repositories, choose between **Standalone** or **Mirror** import types, edit metadata, and import individual repos or run a batch-selection process with real-time logging.
- **NodeGit Pages**: Host static websites directly from your repositories.
  - Resolves files automatically from publishing branches (checks `gh-pages` first, then `main`, then `master`).
  - **Path-based routing**: Websites are served at `/pages/:owner/:repo/`.
  - **Custom Domains**: Bring-Your-Own-CNAME support by adding a `CNAME` file in the publishing branch and pointing the DNS CNAME record of your custom domain to NodeGit.
- **Security First**:
  - **CAPTCHA**: Built-in verification for registration, login, organization creation, and repository transfers.
  - **Encryption**: Support for encryption-at-rest for database operations.
  - **HTTPS**: Native support for secure transit.
  - **Basic Auth**: Git-over-HTTP operations enforce authentication against user credentials for private repositories.
  - **Secret Scanning**: Automatic scanning for sensitive data in your codebase, skipping binary files, and ignoring workflow template placeholders to prevent false positives.
  - **Dependency Scanning**: Keep your project safe with automated dependency vulnerability checks.
- **CI/CD**: Integrated GitHub Actions–compatible runner for automated job execution (Docker-ready).
- **Themeable UI**: Beautiful, GitHub-esque light mode and a custom Lime-on-Black dark mode.
- **Release Management**: Create and view repository tags and releases.

## 🛠️ Tech Stack

- **Backend**: Node.js, Express
- **Database**: SQLite (via `better-sqlite3` and `quick.db`)
- **Templating**: EJS
- **Styling**: Vanilla CSS (Custom design system)
- **Git**: Native Git integration via `child_process`

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Git installed on the server

### Installation

1. **Clone the repository**:

   ```bash
   git clone https://github.com/your-username/NodeGit.git
   cd NodeGit
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Configure environment**:

   ```bash
   cp .env.example .env
   # Edit .env with your specific configuration
   ```

4. **Start the server**:
   ```bash
   npm run dev
   ```

The application will be available at `http://localhost:3000` (or the port specified in your `.env`).

## ⚙️ Configuration

The following environment variables can be configured in your `.env` file:

| Variable            | Description                               | Default                     |
| ------------------- | ----------------------------------------- | --------------------------- |
| `PORT`              | Port the server listens on                | `3000`                      |
| `SESSION_SECRET`    | Secret key for session management         | `super-secret-git-frontend` |
| `DB_ENCRYPTION_KEY` | 32-character key for database encryption  | `None`                      |
| `MAIN_DOMAIN`       | The main application domain name          | `localhost`                 |
| `PAGES_DOMAIN`      | The Pages custom domain base CNAME domain | `pages.nodegitdomain.com`   |

## 🔒 Security

- **CAPTCHA**: The registration and login forms are protected by a custom server-side SVG CAPTCHA to prevent automated sign-ups.
- **HTTPS**: To enable HTTPS, place `key.pem` and `cert.pem` in the root directory. NodeGit will automatically detect them and switch to a secure server.

## 📜 License

This project is licensed under the terms found in the `LICENSE` file.

---

Built with ❤️ by the NodeGit contributors.

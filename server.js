const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const session = require('express-session');
const { router: pagesRouter, customDomainMiddleware } = require('./routes/pages');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(customDomainMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'super-secret-bruv-frontend',
    resave: false,
    saveUninitialized: false
}));

// Provide user context to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
    res.locals.bruvVersion = '2.0.0';
    next();
});

// Routers
const webRouter = require('./routes/web');
const bruvRouter = require('./routes/bruv-server');
const importRouter = require('./routes/import');

app.use('/pages', pagesRouter);
app.use('/', webRouter);
app.use('/import', importRouter);
// The bruv server handles paths like /user/repo
app.use('/', bruvRouter);

// Auto-convert existing git repos to bruv on startup
const gitToBruv = require('./services/git-to-bruv');
const reposDir = path.join(__dirname, 'repos');
if (fs.existsSync(reposDir)) {
    const result = gitToBruv.autoConvertExisting(reposDir);
    console.log(`[startup] Auto-converted ${result.converted} git repos to bruv, skipped ${result.skipped}`);
}

// Start background services
const repoUpdater = require('./services/repo-updater');
repoUpdater.startAutoUpdater();

// HTTPS Support
const sslOptions = {
    key: fs.existsSync('key.pem') ? fs.readFileSync('key.pem') : null,
    cert: fs.existsSync('cert.pem') ? fs.readFileSync('cert.pem') : null
};

if (sslOptions.key && sslOptions.cert) {
    https.createServer(sslOptions, app).listen(PORT, () => {
        console.log(`NodeBruv Frontend Server is running securely on https://localhost:${PORT}`);
    });
} else {
    http.createServer(app).listen(PORT, () => {
        console.log(`NodeBruv Frontend Server is running on http://localhost:${PORT} (Insecure)`);
        console.log(`Tip: Place key.pem and cert.pem in the root to enable HTTPS.`);
    });
}

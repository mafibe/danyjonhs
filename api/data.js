// api/data.js
export default async function handler(req, res) {
    try {
        const GH_TOKEN = process.env.GH_TOKEN || '';
        const GH_USERNAME = process.env.GH_USERNAME || '';
        const GH_REPO = process.env.GH_REPO || '';
        const GH_BRANCH = process.env.GH_BRANCH || 'main';
        const GH_ACTIONS_USERNAME = process.env.GH_ACTIONS_USERNAME || GH_USERNAME;
        const GH_ACTIONS_REPO = process.env.GH_ACTIONS_REPO || GH_REPO;

        if (!GH_TOKEN) {
            return res.status(500).json({ error: 'GH_TOKEN manquant sur Vercel' });
        }
        if (!GH_USERNAME || !GH_REPO) {
            return res.status(500).json({ error: 'GH_USERNAME ou GH_REPO manquant' });
        }

        const userId = req.query.userId || '';
        const ghPath = req.query.path || '';

        if (!ghPath) {
            return res.status(400).json({ error: 'path manquant' });
        }

        const isWorkflowDispatch = ghPath.indexOf('/actions/workflows/') !== -1;
        const isListRequest = req.method === 'GET' && ghPath === '/' && !!userId;
        const isFileAccess = !!userId && ghPath.indexOf('account_' + userId + '_') !== -1;

        let url = '';

        if (isWorkflowDispatch) {
            let workflowPath = ghPath;
            const oldPrefix = '/repos/' + GH_USERNAME + '/' + GH_REPO + '/';
            const newPrefix = '/repos/' + GH_ACTIONS_USERNAME + '/' + GH_ACTIONS_REPO + '/';
            if (workflowPath.indexOf(oldPrefix) !== -1) {
                workflowPath = workflowPath.split(oldPrefix).join(newPrefix);
            }
            url = 'https://api.github.com' + workflowPath;
        } else if (isListRequest) {
            url = 'https://api.github.com/repos/' + GH_USERNAME + '/' + GH_REPO + '/contents/?ref=' + GH_BRANCH;
        } else if (isFileAccess) {
            const parts = ghPath.split('/');
            const fileName = parts[parts.length - 1].split('?')[0];
            url = 'https://api.github.com/repos/' + GH_USERNAME + '/' + GH_REPO + '/contents/' + fileName + '?ref=' + GH_BRANCH;
        } else {
            return res.status(400).json({
                error: 'Paramètres insuffisants',
                debug: { ghPath: ghPath, userId: userId, method: req.method }
            });
        }

        const options = {
            method: req.method,
            headers: {
                Authorization: 'token ' + GH_TOKEN,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'Aliyas-Dashboard'
            }
        };

        if ((req.method === 'PUT' || req.method === 'POST') && req.body) {
            options.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, options);
        const status = response.status;

        if (status === 204) {
            return res.status(204).end();
        }

        let data;
        try {
            data = await response.json();
        } catch (e) {
            return res.status(500).json({
                error: 'Réponse GitHub non JSON',
                status: status
            });
        }

        if (!response.ok) {
            return res.status(status).json({
                error: data.message || ('HTTP ' + status),
                githubStatus: status,
                repo: GH_USERNAME + '/' + GH_REPO,
                tokenPrefix: GH_TOKEN.substring(0, 8) + '...'
            });
        }

        if (isListRequest) {
            const userFiles = Array.isArray(data)
                ? data.filter(function (f) {
                    return f.name && f.name.indexOf('account_' + userId + '_') === 0;
                })
                : [];
            return res.status(200).json(userFiles);
        }

        return res.status(status).json(data);
    } catch (error) {
        return res.status(500).json({
            error: error.message || 'Erreur serveur'
        });
    }
}

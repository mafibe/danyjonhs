// api/check-claim.js – FICHIERS INDIVIDUELS + PAUSE DE 5 MIN + DEBUG
export default async function handler(req, res) {
    const SECRET = process.env.CRON_SECRET;
    const headerSecret = req.headers['x-cron-secret'];
    const querySecret = req.query.secret;
    if ((!headerSecret || headerSecret !== SECRET) && (!querySecret || querySecret !== SECRET)) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    const GH_TOKEN = process.env.GH_TOKEN;
    const GH_USERNAME = process.env.GH_USERNAME;
    const GH_REPO = process.env.GH_REPO;
    const GH_BRANCH = process.env.GH_BRANCH || 'main';

    const GH_ACTIONS_USERNAME = process.env.GH_ACTIONS_USERNAME || GH_USERNAME;
    const GH_ACTIONS_REPO = process.env.GH_ACTIONS_REPO || GH_REPO;

    const CLAIM_WORKFLOW_ID = 'claim.yml';

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log('DEBUG env', { GH_USERNAME, GH_REPO, GH_ACTIONS_USERNAME, GH_ACTIONS_REPO, GH_BRANCH });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Configuration Supabase manquante' });
    }

    try {
        const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        if (!profilesRes.ok) throw new Error('Erreur profils');
        const profiles = await profilesRes.json();
        console.log('DEBUG profiles count', profiles.length);

        const triggered = [];

        for (const profile of profiles) {
            const userId = profile.id;
            const listUrl = `https://api.github.com/repos/${GH_USERNAME}/${GH_REPO}/contents/?ref=${GH_BRANCH}`;
            const listRes = await fetch(listUrl, {
                headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            console.log('DEBUG listRes', userId, listRes.status);
            if (!listRes.ok) continue;
            const files = await listRes.json();
            const userFiles = files.filter(f => f.name.startsWith(`account_${userId}_`));
            console.log('DEBUG userFiles', userId, userFiles.map(f => f.name));

            for (const file of userFiles) {
                const fileUrl = file.url;
                const fileRes = await fetch(fileUrl, {
                    headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
                });
                if (!fileRes.ok) continue;
                const fileData = await fileRes.json();
                const content = decodeURIComponent(
                    Array.from(atob(fileData.content), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
                );
                const account = JSON.parse(content);
                const now = Date.now();

                console.log('DEBUG account', file.name, {
                    enabled: account.enabled,
                    pendingClaim: account.pendingClaim,
                    pendingClaimSince: account.pendingClaimSince,
                    lastClaim: account.lastClaim,
                    timer: account.timer,
                    now
                });

                if (!account.enabled) { console.log('SKIP disabled', file.name); continue; }
                if (account.pendingClaim) {
                    if (account.pendingClaimSince && (now - account.pendingClaimSince) < 5 * 60 * 1000) {
                        console.log('SKIP pendingClaim recent', file.name);
                        continue;
                    }
                }

                const lastClaim = account.lastClaim || 0;
                const timerMs = (account.timer || 60) * 60 * 1000;
                if (now - lastClaim < timerMs) {
                    console.log('SKIP timer not elapsed', file.name, now - lastClaim, timerMs);
                    continue;
                }

                account.pendingClaim = true;
                account.pendingClaimSince = now;
                await updateIndividualFile(file.name, account, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);

                const dispatchUrl = `https://api.github.com/repos/${GH_ACTIONS_USERNAME}/${GH_ACTIONS_REPO}/actions/workflows/${CLAIM_WORKFLOW_ID}/dispatches`;
                const dispatchRes = await fetch(dispatchUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `token ${GH_TOKEN}`,
                        Accept: 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        ref: 'main',
                        inputs: { email: account.email, platform: account.platform, userId: userId }
                    })
                });

                console.log('DEBUG dispatch', file.name, dispatchRes.status);
                if (!dispatchRes.ok) {
                    const errText = await dispatchRes.text();
                    console.log('DEBUG dispatch error body', errText);
                }

                if (dispatchRes.ok) {
                    triggered.push(`${account.email} (${account.platform})`);
                } else {
                    account.pendingClaim = false;
                    delete account.pendingClaimSince;
                    await updateIndividualFile(file.name, account, GH_USERNAME, GH_REPO, GH_BRANCH, GH_TOKEN);
                }
            }
        }

        return res.json({ status: 'ok', triggered: triggered.join(', ') });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}

async function updateIndividualFile(fileName, data, owner, repo, branch, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${fileName}?ref=${branch}`;
    const getRes = await fetch(url, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) return;
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: 'Mise à jour compte individuel', content, branch, sha })
    });
}

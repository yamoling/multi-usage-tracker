// Codex (ChatGPT) usage client. Reads the token the Codex CLI keeps in
// $CODEX_HOME/auth.json (default ~/.codex) and calls the ChatGPT backend that
// the CLI's own /status uses. Pure GI like usageClient.js: no shell imports, so
// it runs under plain `gjs` (tools/poll-codex.js) as well as in the shell.
//
// The token is only read, never refreshed or written back: the Codex CLI
// rotates its refresh token on use, and a second writer racing it could sign
// the CLI out. When the access token lapses the popup asks to run `codex`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {UsageError, SignedOutError} from './usageClient.js';
import {decoder} from './oauth.js';

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

// The directory the Codex CLI keeps auth.json in: $CODEX_HOME, else ~/.codex.
export function defaultCodexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

// Payload of a JWT (unverified; only used for display), or null.
function jwtClaims(token) {
    try {
        const part = String(token ?? '').split('.')[1];
        if (!part)
            return null;
        let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        b64 += '='.repeat((4 - (b64.length % 4)) % 4);
        return JSON.parse(decoder.decode(GLib.base64_decode(b64)));
    } catch {
        return null;
    }
}

function loadFile(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                const [, data] = f.load_contents_finish(res);
                resolve(data);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class CodexClient {
    constructor({codexHome = defaultCodexHome()} = {}) {
        this._codexHome = codexHome;
        this._session = new Soup.Session();
        this._session.timeout = 15;
    }

    // {accessToken, accountId, email, plan} from auth.json. Throws
    // SignedOutError when there is no ChatGPT sign-in to use.
    async readAuth() {
        let root;
        try {
            const bytes = await loadFile(GLib.build_filenamev([this._codexHome, 'auth.json']));
            root = JSON.parse(decoder.decode(bytes));
        } catch {
            throw new SignedOutError('Not signed in. Run `codex login` to sign in with ChatGPT.');
        }
        const tokens = root?.tokens ?? root;
        if (!tokens?.access_token) {
            // An API-key login has no subscription limits to report.
            throw new SignedOutError(root?.OPENAI_API_KEY
                ? 'Codex is using an API key. Usage limits need a ChatGPT sign-in (`codex login`).'
                : 'Not signed in. Run `codex login` to sign in with ChatGPT.');
        }
        const claims = jwtClaims(tokens.id_token) ?? {};
        const auth = claims['https://api.openai.com/auth'] ?? {};
        return {
            accessToken: tokens.access_token,
            accountId: tokens.account_id ?? auth.chatgpt_account_id ?? null,
            email: claims.email ?? null,
            plan: auth.chatgpt_plan_type ?? null,
        };
    }

    _get(url, auth, cancellable) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            const headers = msg.get_request_headers();
            headers.append('Authorization', `Bearer ${auth.accessToken}`);
            headers.append('Accept', 'application/json');
            headers.append('User-Agent', 'codex-cli');
            if (auth.accountId)
                headers.append('ChatGPT-Account-Id', auth.accountId);

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    // Raw integer, not get_status(): see usageClient.js.
                    const status = msg.status_code;
                    const text = bytes ? decoder.decode(bytes.get_data()) : '';
                    if (status < 200 || status >= 300) {
                        reject(new UsageError(`HTTP ${status} from ${url}`, {status, body: text}));
                        return;
                    }
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // Resolves to {usage, resetCredits, account}. resetCredits is the detail
    // list of banked resets, only fetched when the usage payload says there are
    // any (saves a request per poll); a failure there is non-fatal.
    async fetchUsage(cancellable = null) {
        const auth = await this.readAuth();
        const usage = await this._get(CODEX_USAGE_URL, auth, cancellable);
        let resetCredits = null;
        if (Number(usage?.rate_limit_reset_credits?.available_count) > 0) {
            try {
                resetCredits = await this._get(CODEX_RESET_CREDITS_URL, auth, cancellable);
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                logError(e, 'codex-usage: reset-credit details unavailable (non-fatal)');
            }
        }
        return {usage, resetCredits, account: {email: auth.email, plan: auth.plan}};
    }
}

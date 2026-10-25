// Error types shared by every usage client. No imports, so the pure models and
// plain `node` tests can use them too.

export class UsageError extends Error {
    constructor(message, {status = 0, body = ''} = {}) {
        super(message);
        this.name = 'UsageError';
        this.status = status;
        this.body = body;
    }

    // The API's own explanation, when the body is the usual
    // {"error": {"message": "..."}} shape. Null when the body isn't JSON or
    // doesn't look like that, so callers can fall back to a generic message.
    apiMessage() {
        try {
            return JSON.parse(this.body)?.error?.message || null;
        } catch {
            return null;
        }
    }
}

// No usable credentials: the account was never signed in (or the sign-in was
// removed). The caller renders a muted "signed out" state rather than an
// error, since nothing actually went wrong.
export class SignedOutError extends UsageError {
    constructor(message = 'Not signed in for this profile.') {
        super(message);
        this.name = 'SignedOutError';
        this.signedOut = true;
    }
}

// Small async helpers shared by the usage clients: one JSON request over
// libsoup and one async file read. Pure GI (no shell imports), so the clients
// stay runnable under plain `gjs` (tools/poll*.js) as well as in the shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {UsageError} from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A Soup session with the timeout every client uses.
export function newSession() {
    const session = new Soup.Session();
    session.timeout = 15;
    return session;
}

/**
 * Sends one request and resolves to the parsed JSON body ({} when empty).
 * A non-2xx status rejects with a UsageError carrying the status and body.
 * @ai-generated
 */
export function requestJson(session, method, url, {headers = {}, jsonBody, cancellable = null} = {}) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new(method, url);
        const requestHeaders = msg.get_request_headers();
        requestHeaders.append('Accept', 'application/json');
        for (const [name, value] of Object.entries(headers)) {
            if (value !== null && value !== undefined)
                requestHeaders.append(name, String(value));
        }
        if (jsonBody !== undefined) {
            const raw = encoder.encode(JSON.stringify(jsonBody));
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(raw));
        }

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                // Read the raw integer; msg.get_status() marshals to the
                // Soup.Status enum, which lacks some codes (e.g. 429) and
                // would throw "N is not a valid value for enumeration Status".
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

// Reads and parses a JSON file without blocking the main loop. Rejects when
// the file is missing or is not valid JSON.
export function loadJsonFile(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                const [, data] = f.load_contents_finish(res);
                resolve(JSON.parse(decoder.decode(data)));
            } catch (e) {
                reject(e);
            }
        });
    });
}

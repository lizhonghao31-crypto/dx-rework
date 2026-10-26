import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApplicationError } from '../platform/errors.js';
// Direct in-process service tests may omit a secret. HTTP uses the existing
// session secret; no credential or global configuration is added or changed.
const localSecret = randomBytes(32).toString('hex');
export class SlaPreviewTokens {
    constructor(private readonly secret: string = localSecret) { }
    issue(fingerprint: string) {
        const body = Buffer.from(JSON.stringify({ fingerprint, issuedAt: Date.now() })).toString('base64url');
        return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
    }
    verify(token: string, fingerprint: string) {
        const reject = (): never => { throw new ApplicationError('DIGITAL_TASK_CONFLICT', '预览已变化或失效，请重新预览后应用', 409); };
        const [body, signature, extra] = token.split('.');
        if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature))
            reject();
        const expected = createHmac('sha256', this.secret).update(body!).digest('base64url');
        if (signature!.length !== expected.length || !timingSafeEqual(Buffer.from(signature!), Buffer.from(expected)))
            reject();
        let data: {
            fingerprint?: unknown;
            issuedAt?: unknown;
        };
        try {
            data = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
        }
        catch {
            return reject();
        }
        const now = Date.now();
        if (!data || typeof data!=='object' || data.fingerprint !== fingerprint || typeof data.issuedAt !== 'number' || !Number.isSafeInteger(data.issuedAt) || data.issuedAt > now || now - data.issuedAt > 300000)
            reject();
    }
}

import { afterEach, expect, it, vi } from 'vitest';
import { SlaPreviewTokens } from '../../apps/api/src/production-platform/sla-preview-token.js';
afterEach(() => vi.restoreAllMocks());
it('authenticates a preview, binding inputs and session signing identity', () => {
    const tokens = new SlaPreviewTokens('test-preview-secret');
    const token = tokens.issue('draft-a');
    expect(() => tokens.verify(token, 'draft-a')).not.toThrow();
    for (const [value, fingerprint] of [[token, 'draft-b'], [token + 'x', 'draft-a'], ['not-signed', 'draft-a']])
        expect(() => tokens.verify(value!, fingerprint!)).toThrow(/预览/);
    expect(() => new SlaPreviewTokens('different-server-secret').verify(token, 'draft-a')).toThrow(/预览/);
});
it('expires by real audit time, rejects future previews, and preserves exact boundary', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000000), tokens = new SlaPreviewTokens('test');
    const token = tokens.issue('draft');
    now.mockReturnValue(1300000);
    expect(() => tokens.verify(token, 'draft')).not.toThrow();
    now.mockReturnValue(1300001);
    expect(() => tokens.verify(token, 'draft')).toThrow(/失效/);
    now.mockReturnValue(999999);
    expect(() => tokens.verify(token, 'draft')).toThrow(/失效/);
});

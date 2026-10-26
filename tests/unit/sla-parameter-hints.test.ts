import { expect, it } from 'vitest';
import { DIGITAL_SLA_PARAMETERS } from '../../packages/contracts/src/digital-sla.js';
import { slaParameterHints } from '../../apps/web/src/sla-parameter-hints.js';
it('provides business-language timing boundaries for every fixed parameter without a gate editor', () => {
    expect(Object.keys(slaParameterHints).sort()).toEqual(DIGITAL_SLA_PARAMETERS.map(p => p.key).sort());
    for (const p of DIGITAL_SLA_PARAMETERS)
        expect(slaParameterHints[p.key]).not.toMatch(/^[a-z_]+$/);
    expect(slaParameterHints.bulk_cutting).toMatch(/不新增裁床收布/);
    expect(slaParameterHints.ship_sample).toMatch(/不拦其他业务/);
});

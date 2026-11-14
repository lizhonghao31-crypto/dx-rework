import type {JourneyBusinessDate} from '@dx-rework/contracts/digital-production-journey';
import {slaDateBoundary} from './digital-sla-plan.js';
const instant=(at:string|null|undefined):number|null=>{if(!at||!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at))return null;const value=Date.parse(at);return Number.isFinite(value)?value:null;};
/** A forecast day has the existing Beijing exclusive boundary for calculation.
 * Keep its original date/precision for display; it is never an actual event.
 */
function forecastBoundary(expected: JourneyBusinessDate): number | null {
  if (expected.status !== 'complete') return null;
  if (expected.precision === 'instant') return instant(expected.at);
  if (expected.precision !== 'date' || !expected.at) return null;
  try {
    return instant(slaDateBoundary(expected.at).at);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid SLA calendar date') return null;
    throw error;
  }
}

/** Natural elapsed time is independent from each node's business SLA calendar.
 * A date-only start without an approved calculation boundary remains unknown.
 */
export function naturalTimeRatio(start: string | null, expected: JourneyBusinessDate, asOf: string): number | null {
  const from = instant(start), now = instant(asOf);
  const until = forecastBoundary(expected);
  if (from === null || until === null || now === null || until <= from) return null;
  return Math.max(0, Math.min(1, (now - from) / (until - from)));
}


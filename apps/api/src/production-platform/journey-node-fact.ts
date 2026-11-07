import type { JourneyNode } from '@dx-rework/contracts/digital-production-journey';

export type JourneyNodeFact = Pick<JourneyNode, 'key' | 'instanceId' | 'round'>
  & { [Field in keyof Omit<JourneyNode, 'key' | 'instanceId' | 'round'>]?: JourneyNode[Field] | undefined };

/** A kind-wide observation cannot select a PO or attempt when several are live. */
export function journeyNodeFactTarget(nodes: JourneyNode[], key: string, round: number | null): JourneyNode | undefined {
  const current = nodes.filter(node => node.key === key && node.current);
  return current.length === 1 ? current[0]
    : current.find(node => node.instanceId === `${key}:${round ?? 0}` && node.round === round);
}

/** An omitted observation cannot erase another proof for this exact instance.
 * Explicit null is an authoritative clearing observation, not a default value.
 */
export function mergeJourneyNodeFact(previous: JourneyNode, fact: JourneyNodeFact): JourneyNode | null {
  if (previous.key !== fact.key || previous.instanceId !== fact.instanceId || previous.round !== fact.round
    || fact.current !== undefined && previous.current !== fact.current) return null;
  const supplied = Object.fromEntries(Object.entries(fact).filter(([, value]) => value !== undefined));
  const result = { ...previous, ...supplied } as JourneyNode;
  if (fact.actualAt !== undefined && fact.actualDate === undefined) result.actualDate = null;
  if (fact.actualAt === null && fact.actualDate == null) {
    if (fact.actualQuality === undefined) result.actualQuality = 'missing';
    result.completionResult = result.state === 'completed' ? 'unknown' : null;
    result.overdueSeconds = null;
  }
  if (fact.state !== undefined && !['completed', 'inherited'].includes(fact.state)) {
    result.actualAt = null; result.actualDate = null; result.actualQuality = 'missing';
    result.operator = null; result.completionResult = null; result.overdueSeconds = null;
  }
  return result;
}

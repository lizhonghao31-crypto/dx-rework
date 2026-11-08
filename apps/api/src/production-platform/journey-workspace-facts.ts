import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import type {JourneySelection} from './journey-projection.js';
/** Internal selection facts only. Page cards still hydrate through the original
 * authorized native projection; these keys are never returned as full cards. */
export type WorkspaceNodeFact=Pick<JourneyNode,'key'|'instanceId'|'stage'|'state'|'current'|'planningOnly'|'risks'|'countsInProgress'|'owner'>&{nativeTask:boolean};
export type WorkspaceJourneyFact=JourneySelection&{asOf:string;nodes:WorkspaceNodeFact[]};

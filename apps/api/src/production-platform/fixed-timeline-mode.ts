import type {Pool} from 'pg';

export type TimelineAdoptionMode='legacy'|'fixed_v2';
// Deployment policy belongs to the actual application pool, not a user's auth
// result or a process-wide test flag. Existing objects use their stored version.
const adoptionModes=new WeakMap<Pool,TimelineAdoptionMode>();
export function configureTimelineAdoption(database:Pool,mode:TimelineAdoptionMode){adoptionModes.set(database,mode);}
export function newTimelineAdoptionMode(database:Pool):TimelineAdoptionMode{return adoptionModes.get(database)??'legacy';}

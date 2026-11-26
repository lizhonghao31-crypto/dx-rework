import {createContext} from 'react';
import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';

export type RevisionCommentIntent={
 ref:NonNullable<DevelopmentRevision['customerCommentRef']>;
 text:string;
 evidenceRefs:readonly string[];
 repeatBase?:{sourceId:string;roundNumber:number};
};
export const RevisionCommentIntentContext=createContext<{
 target:RevisionCommentIntent|null;
 start:(intent:RevisionCommentIntent)=>void;
 clear:(intent:RevisionCommentIntent)=>void;
}|null>(null);

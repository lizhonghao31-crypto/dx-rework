import type {ReactNode} from 'react';
export function PatternBoardLane({lane,title,count,icon,onAll,children}:{lane:string;title:string;count:number|string;icon?:ReactNode;onAll?:()=>void;children:ReactNode}){
 return <section className={`pattern-board-column lane-${lane}`}><h3 className="pattern-lane-heading"><i aria-hidden="true">{icon}</i>{title}<span>{count}</span>{onAll&&<button type="button" className="development-text-action pattern-lane-more" onClick={onAll}>查看全部</button>}</h3><div className="pattern-lane-cards">{children}</div></section>;
}
export function PatternBoardCard({children,onClick,overdue=false}:{children:ReactNode;onClick:()=>void;overdue?:boolean}){
 return <button type="button" className={`pattern-task-card${overdue?' is-overdue':''}`} onClick={onClick}>{children}</button>;
}

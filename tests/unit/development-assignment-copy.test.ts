import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DevelopmentAssignmentTable} from '../../apps/web/src/development-assignment-table.js';
import type {useDevelopmentExecution} from '../../apps/web/src/digital-development-execution-panel.js';
it.each([true,false])('uses the server arrangement validity for an existing assignee outside the normal candidate list (%s)',valid=>{
 const controller={state:{canDispatch:true,sheet:{sourceId:'TEST-source'},tasks:[],arrangement:{roundNumber:1,version:1,readyToArrange:true,canEdit:true,rows:[{kind:'development_sewing',label:'车板',assigneeId:'TEST-existing-root',assigneeName:'TEST原安排人员',requiredRole:'pattern_room_worker',valid,editable:true,taskId:null}]}},people:[],peopleFor:'TEST-source:1',busy:false} as unknown as ReturnType<typeof useDevelopmentExecution>;
 const html=renderToStaticMarkup(createElement(DevelopmentAssignmentTable,{controller,editing:true}));expect(html).toContain(valid?'当前有效安排':'需重新核对安排资格');expect(html).not.toContain('当前不可安排');expect(html).toContain('TEST-existing-root');
});

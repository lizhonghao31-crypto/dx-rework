import {useTodoContentRead} from './todo-content-read.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {Button} from '@dx-rework/ui';
import type {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DevelopmentMaterialVerification} from './development-material-verification.js';
export function DevelopmentMaterialCheck({controller,task}:{controller:ReturnType<typeof useDevelopmentExecution>;task:DigitalTask}){
 const readRef=useTodoContentRead({routeName:'digital_production_task',entityId:task.taskId,developmentRound:task.routeVersion},Boolean(controller.state?.materialVerification&&!controller.readError));
 if(controller.state?.materialVerification)return <div ref={readRef}><DevelopmentMaterialVerification controller={controller} task={task}/></div>;
 return <section role="status"><h3>核料输入功能尚未就绪</h3><p>未取得本轮文员确认资料，当前不能保存或提交。请重新读取；仍未恢复时，请管理员核实 API 与材料确认数据库版本。旧资料里的“不需”不代表文员确认不用。</p><Button type="button" disabled={controller.busy||controller.reading} onClick={()=>void controller.recheck()}>重新读取核料资料</Button></section>;
}

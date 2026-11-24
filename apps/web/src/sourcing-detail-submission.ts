import {useSubmissionFeedback} from "./submission-feedback.js";
import type {SourcingDetailIdentity} from "./sourcing-detail-read.js";

type Owner={canSubmit:boolean;capture:()=>SourcingDetailIdentity;owns:(identity:SourcingDetailIdentity)=>boolean};

/** The existing recovery coordinator retains the original operation, body and
 * key. Entity ownership governs callbacks, never cancellation of the POST. */
export function useSourcingDetailSubmission(owner:Owner,setBusy:(busy:boolean)=>void){
  const feedback=useSubmissionFeedback(setBusy);
  const run=async<T,>(operation:()=>Promise<T>,saved:(value:T,identity:SourcingDetailIdentity)=>Promise<void>|void,
    handleDefinitiveRefusal?:(error:unknown,identity:SourcingDetailIdentity)=>boolean)=>{
    if(!owner.canSubmit)return false;
    const identity=owner.capture();let applied=false;
    await feedback.run(async()=>{
      if(!owner.owns(identity))return;
      let value:T;
      try{value=await operation();}
      catch(error){
        // Only the original command can distinguish a refusal reached after replay lookup.
        if(handleDefinitiveRefusal?.(error,identity))return;
        throw error;
      }
      feedback.confirmed();
      if(!owner.owns(identity))return;
      applied=true;
      await saved(value,identity);
    });
    return applied;
  };
  return {feedback,run};
}

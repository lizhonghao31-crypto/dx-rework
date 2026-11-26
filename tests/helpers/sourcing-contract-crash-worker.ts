import pg from 'pg';
import {SourcingContractService} from '../../apps/api/src/sourcing/sourcing-contract-service.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {AcceptanceObjectStorage} from '../../apps/api/src/tools/acceptance-storage.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

type CrashFixture = {
  connectionString: string;
  schemaOptions: string;
  directory: string;
  actor: TrustedActorContext;
  caseId: string;
  documentId: string;
  checkpoint: 'claim' | 'object';
};

process.once('message', async (input: CrashFixture) => {
  const db=new pg.Pool({connectionString:input.connectionString,options:input.schemaOptions});
  const storage=new AcceptanceObjectStorage(input.directory,'http://localhost','TEST isolated contract crash storage');
  const attachments=new AttachmentService(db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
  const terminate=()=>process.kill(process.pid,'SIGKILL');
  if(input.checkpoint==='claim'){
    const stage=attachments.stageContractPdf.bind(attachments);
    attachments.stageContractPdf=(...args)=>{
      terminate();
      return stage(...args);
    };
  }else{
    const write=storage.writeImmutable.bind(storage);
    storage.writeImmutable=async(...args)=>{
      await write(...args);
      terminate();
    };
  }
  try {
    await new SourcingContractService(db,attachments).generateIfReady(input.actor,input.caseId,input.documentId);
    process.send?.({error:'The expected contract crash checkpoint was not reached'});
  } catch (error) {
    process.send?.({error:error instanceof Error?error.message:'Unexpected fixture failure'});
  } finally {
    await db.end();
    process.disconnect?.();
  }
});

import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import type {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';

/** Historical ready image on the real full-App mother, not a mocked image DTO. */
export async function cockpitThumbnailFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,orderId:string){
 const identity=new DigitalProductionIdentityService(f.db,true),designer=f.root,order=await identity.read(f.root,orderId);
 const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
 const bytes=await sharp({create:{width:1200,height:800,channels:3,background:'#3482be'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex'),attachmentId=randomUUID(),objectKey='TEST/home-preview/'+attachmentId;
 await f.storage.writeImmutable(objectKey,bytes,{mimeType:'image/png',sha256});
 await f.db.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)VALUES($1,$2,'TEST-old-home.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)`,[attachmentId,objectKey,bytes.length,sha256,designer.actorId]);
 const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:null,sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST full-App photo',craft:'无',washing:'免洗',materials:[],files:[{attachmentId,kind:'款图'}]});
 await new DigitalDevelopmentService(f.db,true).save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());
 await identity.attachSource(f.root,orderId,source.sourceId,randomUUID());
 let originalGenerationReads=0;const read=f.storage.readBytes.bind(f.storage);
 f.storage.readBytes=async(key,max,signal?:AbortSignal)=>{if(key===objectKey&&signal)originalGenerationReads++;return read(key,max);};
 return {imagePath:`/api/digital-production/sources/${source.sourceId}/development/attachments/${attachmentId}`,objectKey,styleNo:order.designStyleNo,originalBytes:bytes.length,originalSha256:sha256,generationReads:()=>originalGenerationReads};
}

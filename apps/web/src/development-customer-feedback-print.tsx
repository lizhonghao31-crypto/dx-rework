import type {DevelopmentPrintFeedback} from '@dx-rework/contracts/digital-development';

type PrintIdentity={orderNumber:string;styleNo:string;customer:string;designer:string;round:string;version:string};

/** The caller supplies the already authorized, exact adopted feedback. This
 * renderer does not resolve a parent, the latest comment, or any attachments. */
export function DevelopmentCustomerFeedbackPrint({identity,feedback}:{identity:PrintIdentity;feedback:DevelopmentPrintFeedback}){
 return <article className="development-print-document development-feedback-document" aria-label="客户评语单" data-print-document="客户评语单">
  <div data-print-cover>
   <header className="development-paper-title"><strong>广州市达兴制衣有限公司</strong><h2>客户评语单 <small>复版制作依据</small></h2></header>
   <dl className="development-paper-fields">
    {Object.entries({"订单ID":identity.orderNumber,"款号":identity.styleNo,"客户":identity.customer,"设计师":identity.designer,"对应复版":identity.round,"版单资料版本":identity.version}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'—'}</dd></div>)}
   </dl>
   <dl className="development-paper-fields development-paper-dates"><div><dt>评语来源</dt><dd>原开发单第{feedback.sourceRound}轮</dd></div><div><dt>评语版本</dt><dd>{feedback.version===undefined?'原记录未关联评语版本':`v${feedback.version}`}</dd></div>{feedback.recordedOn&&<div><dt>评语登记日</dt><dd>{feedback.recordedOn}</dd></div>}</dl>
  </div>
  <section className="development-feedback-text" data-print-split-text><h3 className="development-paper-bar">客户原评语</h3><p>{feedback.text}</p></section>
  {feedback.images?.map((image,index)=><figure key={image.attachmentId} className="development-feedback-image" data-print-feedback-image>
   <h3 className="development-paper-bar">客户评语图片</h3>
   <img src={image.url} alt={image.label||`客户评语原图 ${index+1}`}/>
   <figcaption>图 {index+1}{image.label?` · ${image.label}`:''}</figcaption>
  </figure>)}
 </article>;
}

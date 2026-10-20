/** Preserve real server reasons; an HTTP fallback cannot invent state changes. */
export function requestFailureMessage(status:number,message?:string,method?:string):string {
 const reading=method?.toUpperCase()==='GET'||method?.toUpperCase()==='HEAD';
 if(method&&!reading&&(status>=500||status===408))return `${message?.trim()?message.trim()+'。':''}未收到可确认的提交结果，请先核对原记录，避免重复提交`;
 if(message?.trim())return message;
 return status===401?'登录已失效，请重新登录后从原记录重试':status===403?reading?'当前身份无权读取此资料，请返回原工作台核对授权':'当前身份无权执行此操作，请返回原工作台核对授权':status===404?'所请求的记录不存在或当前不可见，请从原入口核对':status===409?'请求未被接受，具体原因尚未返回；请从原记录核对后再操作':status===400||status===422?reading?'读取请求未通过校验，请核对查询条件后重新读取':'提交资料未通过校验，请检查填写内容':reading?'服务暂时不可用，未能读取原资料，请稍后重新读取':'服务暂时不可用，请稍后核对原记录';
}
export function transportFailure(method:string):Error {
 return new Error(['GET','HEAD'].includes(method.toUpperCase())?'网络连接失败，未能读取资料，请重试':'未收到可确认的提交结果，请先核对原记录，避免重复提交');
}

/** Preserve server business reasons; transport failures never imply a rejected write. */
export function requestFailureMessage(status:number,message?:string):string {
 if(message?.trim())return message;
 return status===401?'登录已失效，请重新登录后重试':status===403?'当前身份无权执行此操作':status===404?'所请求的记录不存在或当前不可见':status===409?'资料或状态已变化，请刷新核对后重试':status===400||status===422?'提交资料格式不正确，请检查填写内容':'服务暂时不可用，请稍后重试';
}
export function transportFailure(method:string):Error {
 return new Error(method.toUpperCase()==='GET'?'网络连接失败，未能读取资料，请重试':'未收到可确认的提交结果，请先核对原记录，避免重复提交');
}

import type { DigitalProductionNotificationService } from "./notification-service.js";
export class DigitalNotificationRuntime {
  private timer:ReturnType<typeof setInterval>|undefined;
  private running:Promise<void>|undefined;
  constructor(private readonly service:Pick<DigitalProductionNotificationService,"runOnce">,private readonly logger:{warn(value:unknown,message:string):void},private readonly intervalMs=60_000) {
    if(!Number.isFinite(intervalMs)||intervalMs<1000)throw new Error("Invalid digital notification interval");
  }
  private kick=()=>{if(this.running)return;this.running=this.service.runOnce().catch(()=>this.logger.warn({},"digital in-app notification scan failed")).finally(()=>{this.running=undefined;});};
  start(){if(this.timer)return;this.timer=setInterval(this.kick,this.intervalMs);this.timer.unref();this.kick();}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running;}
}

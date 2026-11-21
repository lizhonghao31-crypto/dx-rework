import {beginForegroundWait} from "./foreground-loading.js";
import {registerSessionInvalidator} from "./auth-session.js";
import {useEffect,useRef,useState} from "react";
import {hasWarehouseReceivingRole} from "@dx-rework/contracts";
import {createWebUrls} from "../url-contract.js";
import {moduleCanWrite} from "./member-module-policy.js";
import {verifySession} from "./auth.js";
import {shanghaiBusinessDate} from "./business-date.js";
import {receivingBoardRead} from "./receiving-board-request.js";
import {useDebouncedValue} from "./use-debounced-value.js";
import type {BoardStatus,BoardResult} from "./receiving-board-types.js";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
export const localDate=():string=>shanghaiBusinessDate();

/** Original page filters, current authorization and read-only response lifecycle. */
export function useReceivingBoardRead(targetBatchId:string|undefined,invalidTarget:boolean){
  const [startDate, setStartDate] = useState(localDate);

  const [endDate, setEndDate] = useState(localDate);

  const [query, setQuery] = useState("");

  const [status, setStatus] = useState<BoardStatus>("all");

  const debouncedQuery = useDebouncedValue(query, 180);

  const [data, setData] = useState<BoardResult | null>(null);

  const [message, setMessage] = useState("正在加载订单回货…");

  const [pageLoading, setPageLoading] = useState(false);

  const [canReceive, setCanReceive] = useState(false);

  const [canInitiate, setCanInitiate] = useState(false);

  const [canInitiateFinishing, setCanInitiateFinishing] = useState(false);

  const [canExport, setCanExport] = useState(false);

  const [canResolveDifferences, setCanResolveDifferences] = useState(false);

  const [canManagePacking, setCanManagePacking] = useState(false);

  const [isRoot, setIsRoot] = useState(false);

  const [refreshToken, setRefreshToken] = useState(0);
  const [actorEpoch,setActorEpoch]=useState(0);
  const controller=useRef<AbortController|null>(null);
  const lastQuery=useRef<{path:string;scope:string}|null>(null);
  const explicitRetry=useRef(false);
  const retryRead=()=>{
    if(controller.current||explicitRetry.current)return;
    explicitRetry.current=true;
    setRefreshToken(value=>value+1);
  };

  const [page, setPage] = useState(1);

  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());

  const [readFailed,setReadFailed]=useState(false);

  const resetPagination = () => {
    setPage(1);
  };

  useEffect(() => {
    let active = true;
    void verifySession()
      .then((session) => {
        if (!active || session === "denied" || session.status !== "authorized") return;
        const isRoot = session.user.isRoot === true;
        const roles = session.user.businessRoles ?? [];
        const capabilities = session.user.capabilities;
        const warehouseReceiver = hasWarehouseReceivingRole(roles)
          && capabilities.includes("receiving:create");
        const qualityControl = roles.includes("quality_control")
          && capabilities.includes("rework:initiate");
        setCanReceive(isRoot || warehouseReceiver);
        setCanInitiate(moduleCanWrite(session.user, "rework") && (isRoot || roles.includes("owner_group") || qualityControl));
        setCanInitiateFinishing(moduleCanWrite(session.user, "rework") && (isRoot || roles.includes("owner_group")
          || (roles.includes("tail_supervisor") && capabilities.includes("process:configure"))));
        setCanExport(isRoot || capabilities.includes("receiving:export"));
        setCanResolveDifferences(isRoot || (
          roles.includes("order_merchandiser") && capabilities.includes("receiving:resolve_difference")
        ));
        setCanManagePacking(isRoot || (
          hasWarehouseReceivingRole(roles) && capabilities.includes("receiving:packing_manage")
        ));
        setIsRoot(isRoot);
      })
      .catch(() => {
        if (!active) return;
        setCanReceive(false);
        setCanInitiate(false);
        setCanInitiateFinishing(false);
        setCanExport(false);
        setCanResolveDifferences(false);
        setCanManagePacking(false);
        setIsRoot(false);
      });
    return () => { active = false; };
  }, [actorEpoch]);

  const currentSearch=debouncedQuery.trim().toUpperCase();
  const readySearch=Boolean(targetBatchId)||currentSearch===query.trim().toUpperCase();
  const params = new URLSearchParams({ startDate, endDate });
  params.set("status", status);
  params.set("page", String(page));
  if(targetBatchId){params.set("receivingBatchId",targetBatchId);params.set("status","all");params.set("page","1");}
  if(currentSearch)params.set("q",currentSearch);
  const path=apiUrl(`receiving/board?${params}`);
  const scope=targetBatchId??"board";
  useEffect(()=>registerSessionInvalidator(()=>{
    controller.current?.abort();
    setData(null);setCanReceive(false);setCanInitiate(false);setCanInitiateFinishing(false);
    setCanExport(false);setCanResolveDifferences(false);setCanManagePacking(false);setIsRoot(false);
    setActorEpoch(value=>value+1);
  }),[]);
  useEffect(() => {
    if(invalidTarget){setData(null);setPageLoading(false);setReadFailed(false);setMessage("收货批次链接无效，请返回来源订单");return;}
    if(!readySearch){setPageLoading(false);return;}
    const abort=new AbortController(),previous=lastQuery.current;
    controller.current=abort;
    if(previous&&previous.scope!==scope)setData(null);
    const finish=explicitRetry.current||previous?.path!==path?beginForegroundWait():()=>{};
    explicitRetry.current=false;lastQuery.current={path,scope};
    setPageLoading(true);setReadFailed(false);
    void receivingBoardRead<BoardResult>(path,abort.signal).then(body=>{
      if(abort.signal.aborted)return;
      setData(body);
      setMessage(body.rows.length?"":body.mode==="search"?"全时间范围内没有匹配的收货记录":"选中日期内没有收货记录");
    }).catch((error:unknown)=>{
      if(abort.signal.aborted)return;
      setData(null);setReadFailed(true);
      setMessage(error instanceof Error?error.message:"订单回货加载失败，请刷新后重试");
    }).finally(()=>{
      if(controller.current!==abort)return;
      controller.current=null;setPageLoading(false);finish();
    });
    return ()=>{
      abort.abort();finish();
      if(controller.current===abort)controller.current=null;
    };
  },[path,scope,readySearch,refreshToken,actorEpoch,invalidTarget]);

  const toggleHistory = (receivingBatchId: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(receivingBatchId)) next.delete(receivingBatchId);
      else next.add(receivingBatchId);
      return next;
    });
  };
  return {
    startDate,setStartDate,endDate,setEndDate,query,setQuery,
    status,setStatus,debouncedQuery,data,message,pageLoading,
    paginationAvailable:readySearch&&!pageLoading&&!readFailed&&lastQuery.current?.path===path,
    canReceive,canInitiate,canInitiateFinishing,canExport,canResolveDifferences,canManagePacking,
    isRoot,setRefreshToken,retryRead,setPage,expandedRows,readFailed,resetPagination,
    toggleHistory,
  };
}

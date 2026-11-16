import {useEffect,useRef,useState,type Dispatch,type SetStateAction} from "react";
import {createWebUrls} from "../url-contract.js";
import {uploadAttachmentWithRecovery,toolsAttachmentApi,localFileScope} from "./attachment-upload-recovery.js";
import {isImageAttachment,hasInvalidDeclaredImageError,isReceivingImageCandidate,normalizeReceivingImageForUpload,prepareAttachmentForUpload} from "./attachment-upload.js";
import {createClientRequestId} from "./client-request-id.js";
import {createReceivingBoardMutation} from "./receiving-board-request.js";
import type {BoardRow,ReceivingHistoryItem,DifferenceResolution} from "./receiving-board-types.js";
import type {PackingTimeInput} from '@dx-rework/contracts';
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
const uploadReplacementImage = async (source: File): Promise<string> => {
  const upload=async(file:File):Promise<string>=>(await uploadAttachmentWithRecovery(file,`receiving-replacement:${localFileScope(source)}`,toolsAttachmentApi,undefined,undefined,source)).attachmentId;
  const prepared = isImageAttachment(source)
    ? await prepareAttachmentForUpload(source)
    : await normalizeReceivingImageForUpload(source);
  try {
    return await upload(prepared);
  } catch (error) {
    if (!hasInvalidDeclaredImageError(error)) {
      throw error;
    }
    return upload(await normalizeReceivingImageForUpload(source));
  }
};

/** One original page-level unknown-write coordinator, shared by all dialogs. */
export function useReceivingBoardEditSession(setRefreshToken:Dispatch<SetStateAction<number>>){
  const [editing, setEditing] = useState<BoardRow | null>(null);

  const [correctingReceipt, setCorrectingReceipt] = useState<ReceivingHistoryItem | null>(null);

  const [deleting, setDeleting] = useState<BoardRow | null>(null);

  const [editStyleNo, setEditStyleNo] = useState("");

  const [editDocumentQuantity, setEditDocumentQuantity] = useState("");

  const [editActualQuantity, setEditActualQuantity] = useState("");

  const [editDefectiveQuantity, setEditDefectiveQuantity] = useState("");

  const [editImages, setEditImages] = useState<readonly File[]>([]);

  const [receiptSource, setReceiptSource] = useState<"" | "jiashun" | "other_factory">("");

  const [receiptDocumentQuantity, setReceiptDocumentQuantity] = useState("");

  const [receiptActualQuantity, setReceiptActualQuantity] = useState("");

  const [receiptDefectiveQuantity, setReceiptDefectiveQuantity] = useState("");

  const [mutationBusy, setMutationBusy] = useState(false);

  const boardMutation=useRef(createReceivingBoardMutation());

  const [mutationUnknown,setMutationUnknown]=useState(false);

  const [mutationMessage, setMutationMessage] = useState("");

  const [packingEditing, setPackingEditing] = useState<BoardRow | null>(null);

  const [packingQuantity, setPackingQuantity] = useState("");
  const [packingTimeMode,setPackingTimeMode]=useState<PackingTimeInput['mode']>('unknown');
  const [packingTimeValue,setPackingTimeValue]=useState('');

  const [packingRequestKey, setPackingRequestKey] = useState("");

  const [differenceEditing, setDifferenceEditing] = useState<Readonly<{
    row: BoardRow;
    type: "receiving" | "packing";
    resolution: DifferenceResolution | null;
  }> | null>(null);

  const [differenceResult, setDifferenceResult] = useState("");

  const [differenceRequestKey, setDifferenceRequestKey] = useState("");

  const [differenceImages, setDifferenceImages] = useState<readonly { file: File; previewUrl: string }[]>([]);

  const differenceUploaded = useRef(new Map<File, string>());

  const differencePreviewUrls = useRef(new Set<string>());

  const differenceSubmitting = useRef(false);

  useEffect(() => {
    const urls = differencePreviewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }, []);

  const clearDifferenceImages = () => {
    for (const url of differencePreviewUrls.current) URL.revokeObjectURL(url);
    differencePreviewUrls.current.clear();
    differenceUploaded.current.clear();
    setDifferenceImages([]);
  };

  const closeDifference = () => {
    if (differenceSubmitting.current) return;
    clearDifferenceImages();
    setDifferenceEditing(null);
  };

  const selectDifferenceImages = (files: FileList | null) => {
    if (!files?.length || mutationBusy) return;
    const selected = Array.from(files);
    if (differenceImages.length + selected.length > 3) { setMutationMessage("处理凭证最多3张"); return; }
    if (selected.some((file) => !isReceivingImageCandidate(file))) { setMutationMessage("请选择JPEG、PNG、WebP图片"); return; }
    const additions = selected.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      differencePreviewUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setDifferenceImages((current) => [...current, ...additions]);
    setMutationMessage("");
  };

  const openPacking = (row: BoardRow) => {
    if(boardMutation.current.hasUnknown()){setMutationMessage("原提交结果尚未确认，请先核对原提交或仅重新读取记录；不能开始另一笔修改");return;}
    setDifferenceEditing(null);
    setPackingEditing(row);
    setPackingQuantity(row.packingQuantity === null ? "" : String(row.packingQuantity));
    setPackingTimeMode(row.packingRevisionId===null&&!row.packingScopeUnresolved?'now':'unknown');
    setPackingTimeValue('');
    setPackingRequestKey(createClientRequestId());
    setMutationMessage("");
  };

  const submitPacking = async () => {
    if (!packingEditing || mutationBusy || boardMutation.current.hasUnknown()) return;
    const value = Number(packingQuantity);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
      setMutationMessage("装箱数量必须是0到10000000之间的整数");
      return;
    }
    let packingTime:PackingTimeInput;
    if(packingTimeMode==='instant'){
      const at=new Date(`${packingTimeValue}+08:00`);
      if(!packingTimeValue||!Number.isFinite(at.getTime())){setMutationMessage('请填写有效的实际装箱时间（北京时间）');return;}
      packingTime={mode:'instant',value:at.toISOString()};
    }else if(packingTimeMode==='date'){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(packingTimeValue)){setMutationMessage('请填写实际装箱日期');return;}
      packingTime={mode:'date',value:packingTimeValue};
    }else packingTime={mode:packingTimeMode};
    setMutationBusy(true);
    setMutationMessage("");
    try {
      await boardMutation.current.submit('packing',apiUrl(`receiving/batches/${packingEditing.receivingBatchId}/packing-revisions`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": packingRequestKey },
        body: JSON.stringify({
          expectedVersion: packingEditing.version,
          expectedPackingRevisionId: packingEditing.packingRevisionId,
          packingQuantity: value,
          packingTime,
        }),
      });
      setPackingEditing(null);
      setMutationUnknown(false);
      setRefreshToken((current) => current + 1);
      setMutationMessage("装箱数量已保存");
    } catch (error) {
      setMutationUnknown(boardMutation.current.hasUnknown());
      const text = error instanceof Error ? error.message : "装箱数量保存失败";
      setMutationMessage(text);
    } finally {
      setMutationBusy(false);
    }
  };

  const openDifference = (row: BoardRow, type: "receiving" | "packing") => {
    if(boardMutation.current.hasUnknown()){setMutationMessage("原提交结果尚未确认，请先核对原提交或仅重新读取记录；不能开始另一笔修改");return;}
    const resolution = type === "receiving"
      ? row.receivingDifferenceResolution
      : row.packingDifferenceResolution;
    setPackingEditing(null);
    clearDifferenceImages();
    setDifferenceEditing({ row, type, resolution });
    setDifferenceResult("");
    setDifferenceRequestKey(createClientRequestId());
    setMutationMessage("");
  };

  const submitDifference = async () => {
    if (!differenceEditing || differenceEditing.resolution || mutationBusy || differenceSubmitting.current || boardMutation.current.hasUnknown()) return;
    const result = differenceResult.trim();
    if (!result || result.length > 500) {
      setMutationMessage("处理结果不能为空且不能超过500个字符");
      return;
    }
    differenceSubmitting.current = true;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const attachmentIds: string[] = [];
      for (const image of differenceImages) {
        let attachmentId = differenceUploaded.current.get(image.file);
        if (!attachmentId) {
          attachmentId = await uploadReplacementImage(image.file);
          differenceUploaded.current.set(image.file, attachmentId);
        }
        attachmentIds.push(attachmentId);
      }
      const row = differenceEditing.row;
      await boardMutation.current.submit('difference',apiUrl(`receiving/batches/${row.receivingBatchId}/difference-resolutions`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": differenceRequestKey },
        body: JSON.stringify({
          expectedVersion: row.version,
          expectedDocumentQuantity: row.documentQuantity,
          expectedActualQuantity: row.cumulativeActualQuantity,
          expectedPackingRevisionId: row.packingRevisionId,
          differenceType: differenceEditing.type,
          result,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        }),
      });
      clearDifferenceImages();
      setDifferenceEditing(null);
      setMutationUnknown(false);
      setRefreshToken((current) => current + 1);
      setMutationMessage("差异处理结果已保存");
    } catch (error) {
      setMutationUnknown(boardMutation.current.hasUnknown());
      const text = error instanceof Error ? error.message : "差异处理提交失败";
      setMutationMessage(text);
    } finally {
      differenceSubmitting.current = false;
      setMutationBusy(false);
    }
  };

  const openEdit = (row: BoardRow) => {
    if(boardMutation.current.hasUnknown()){setMutationMessage("原提交结果尚未确认，请先核对原提交或仅重新读取记录；不能开始另一笔修改");return;}
    setDeleting(null);
    setEditing(row);
    setEditStyleNo(row.styleNo);
    setEditDocumentQuantity(String(row.documentQuantity));
    setEditActualQuantity(String(row.currentActualQuantity));
    setEditDefectiveQuantity(String(row.currentDefectiveQuantity));
    setEditImages([]);
    setMutationMessage("");
  };

  const openReceiptCorrection = (item: ReceivingHistoryItem) => {
    if(boardMutation.current.hasUnknown()){setMutationMessage("原提交结果尚未确认，请先核对原提交或仅重新读取记录；不能开始另一笔修改");return;}
    setEditing(null);
    setDeleting(null);
    setCorrectingReceipt(item);
    setReceiptSource(
      item.receivingSource === "jiashun" || item.receivingSource === "other_factory"
        ? item.receivingSource
        : "",
    );
    setReceiptDocumentQuantity(String(item.receiptDocumentQuantity));
    setReceiptActualQuantity(String(item.actualQuantity));
    setReceiptDefectiveQuantity(String(item.defectiveQuantity));
    setMutationMessage("");
  };

  const submitReceiptCorrection = async () => {
    if (!correctingReceipt || mutationBusy || boardMutation.current.hasUnknown()) return;
    if (Number(receiptDefectiveQuantity) > Number(receiptActualQuantity)) {
      setMutationMessage("次品数量不能超过实际收货数量");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      await boardMutation.current.submit('receipt',apiUrl(`receiving/receipts/${correctingReceipt.receiptId}/corrections`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: correctingReceipt.batchVersion,
          ...(['initial','backfill'].includes(correctingReceipt.receivingSource)?{}:{source:receiptSource}),
          documentQuantity: Number(receiptDocumentQuantity),
          actualQuantity: Number(receiptActualQuantity),
          defectiveQuantity: Number(receiptDefectiveQuantity),
        }),
      });
      setCorrectingReceipt(null);
      setMutationUnknown(false);
      setRefreshToken((value) => value + 1);
      setMutationMessage("本次收货已修正");
    } catch (error) {
      setMutationUnknown(boardMutation.current.hasUnknown());
      setMutationMessage(error instanceof Error ? error.message : "收货记录修正失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const submitCorrection = async () => {
    if (!editing || mutationBusy || boardMutation.current.hasUnknown()) return;
    if (Number(editDefectiveQuantity) > Number(editActualQuantity)) {
      setMutationMessage("次品数量不能超过实际收货数量");
      return;
    }
    if (editImages.some((file) => !isReceivingImageCandidate(file))) {
      setMutationMessage("请选择手机相册中的图片文件");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const attachmentIds = editImages.length > 0
        ? await Promise.all(editImages.map(uploadReplacementImage))
        : undefined;
      await boardMutation.current.submit('batch',apiUrl(`receiving/batches/${editing.receivingBatchId}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: editing.version,
          styleNo: editStyleNo,
          documentQuantity: Number(editDocumentQuantity),
          actualQuantity: Number(editActualQuantity),
          defectiveQuantity: Number(editDefectiveQuantity),
          ...(attachmentIds ? { attachmentIds } : {}),
        }),
      });
      setEditing(null);
      setMutationUnknown(false);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已修改");
    } catch (error) {
      setMutationUnknown(boardMutation.current.hasUnknown());
      setMutationMessage(error instanceof Error ? error.message : "收货订单修改失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || mutationBusy || boardMutation.current.hasUnknown()) return;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      await boardMutation.current.submit('delete',apiUrl(`receiving/batches/${deleting.receivingBatchId}`), {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: deleting.version }),
      });
      setDeleting(null);
      setMutationUnknown(false);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已删除");
    } catch (error) {
      setMutationUnknown(boardMutation.current.hasUnknown());
      setMutationMessage(error instanceof Error ? error.message : "收货订单删除失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const retryOriginalMutation=async()=>{
    if(mutationBusy)return;setMutationBusy(true);
    try{const command=await boardMutation.current.retry();setMutationUnknown(false);
      const belongs=(value:string)=>command.path.includes(`/${value}`);
      if(command.kind==='packing')setPackingEditing(current=>current&&belongs(current.receivingBatchId)?null:current);
      if(command.kind==='difference'){setDifferenceEditing(current=>current&&belongs(current.row.receivingBatchId)?null:current);clearDifferenceImages();}
      if(command.kind==='receipt')setCorrectingReceipt(current=>current&&belongs(current.receiptId)?null:current);
      if(command.kind==='batch')setEditing(current=>current&&belongs(current.receivingBatchId)?null:current);
      if(command.kind==='delete')setDeleting(current=>current&&belongs(current.receivingBatchId)?null:current);
      setMutationMessage('原提交已确认保存，正在重新读取回货记录；读取失败时仅重读，不重复提交。');setRefreshToken(value=>value+1);
    }catch(error){setMutationUnknown(boardMutation.current.hasUnknown());setMutationMessage(error instanceof Error?error.message:'原提交结果仍未确认，请核对原记录');}
    finally{setMutationBusy(false);}
  };

  const recoveryActions=mutationUnknown?<><button type="button" disabled={mutationBusy} onClick={()=>void retryOriginalMutation()}>使用原内容核对提交结果</button><button type="button" disabled={mutationBusy} onClick={()=>setRefreshToken(value=>value+1)}>仅重新读取回货记录</button><small>关闭窗口不代表撤销；读取结果不会自动当作原提交回执。</small></>:null;
  const removeDifferenceImage=(image:Readonly<{file:File;previewUrl:string}>)=>{
 URL.revokeObjectURL(image.previewUrl);
 differencePreviewUrls.current.delete(image.previewUrl);
 differenceUploaded.current.delete(image.file);
 setDifferenceImages(current=>current.filter(item=>item!==image));
};
  return {
    editing,setEditing,correctingReceipt,setCorrectingReceipt,deleting,setDeleting,
    editStyleNo,setEditStyleNo,editDocumentQuantity,setEditDocumentQuantity,editActualQuantity,setEditActualQuantity,
    editDefectiveQuantity,setEditDefectiveQuantity,editImages,setEditImages,receiptSource,setReceiptSource,
    receiptDocumentQuantity,setReceiptDocumentQuantity,receiptActualQuantity,setReceiptActualQuantity,receiptDefectiveQuantity,setReceiptDefectiveQuantity,
    mutationBusy,boardMutation,mutationUnknown,mutationMessage,setMutationMessage,packingEditing,
    setPackingEditing,packingQuantity,setPackingQuantity,packingTimeMode,setPackingTimeMode,packingTimeValue,setPackingTimeValue,differenceEditing,differenceResult,setDifferenceResult,
    differenceImages,closeDifference,selectDifferenceImages,openPacking,submitPacking,openDifference,
    submitDifference,openEdit,openReceiptCorrection,submitReceiptCorrection,submitCorrection,confirmDelete,
    recoveryActions,removeDifferenceImage,
  };
}

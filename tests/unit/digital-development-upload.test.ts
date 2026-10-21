import {invalidateSession} from "../../apps/web/src/auth-session.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digitalRequest } from "../../apps/web/src/digital-production-api.js";
import { uploadDevelopmentMaterial } from "../../apps/web/src/digital-development-upload.js";
vi.mock("../../apps/web/src/digital-production-api.js",()=>({digitalRequest:vi.fn()}));
const request=vi.mocked(digitalRequest);
const png=()=>new File([new Uint8Array([137,80,78,71,13,10,26,10])],"TEST.png",{type:"image/png"});
const intent={attachmentId:"11111111-1111-4111-8111-111111111111",uploadMethod:"POST",uploadUrl:"http://127.0.0.1/fixture-upload",uploadFields:{key:"TEST"},objectKey:"TEST",expiresAt:"2099-01-01T00:00:00.000Z"};
afterEach(()=>{invalidateSession();vi.restoreAllMocks();vi.unstubAllGlobals();request.mockReset();});
function mockReady(){let input:Record<string,unknown>={};request.mockImplementation(async(path,_method,body)=>{if(path.endsWith('/upload-intents')){input=body as Record<string,unknown>;return intent;}return {attachmentId:intent.attachmentId,...input,status:'ready',createdAt:'2026-10-21T00:00:00.000Z'};});}
describe("development uploads reuse the existing intent and finalization boundary",()=>{
  it("finalizes a successful original once and returns its same attachment ID",async()=>{
    mockReady();
    const upload=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal("fetch",upload);
    expect(await uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",100)).toBe(intent.attachmentId);
    expect(request).toHaveBeenNthCalledWith(2,`sources/TEST/development/attachments/${intent.attachmentId}/finalize`,"POST",{});
    expect((upload.mock.calls[0]![1].body as FormData).get("file")).toMatchObject({name:"TEST.png",size:8});
  });
  it("keeps failed upload unfinalized with a retry instruction, then succeeds through the same public operation",async()=>{
    const original=png();mockReady();
    const upload=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true});vi.stubGlobal("fetch",upload);
    await expect(uploadDevelopmentMaterial("sources/TEST/development",original,"款图",100)).rejects.toThrow("文件传输未完成");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(uploadDevelopmentMaterial("sources/TEST/development",original,"款图",100)).resolves.toBe(intent.attachmentId);
    expect(request.mock.calls.filter(call=>call[0].endsWith("/finalize"))).toHaveLength(1);
    expect(request.mock.calls.filter(call=>call[0].endsWith("/upload-intents"))).toHaveLength(1);expect(upload).toHaveBeenCalledTimes(1);
  });
  it("rejects PDF bytes disguised as a style image, keeps PDF legal for film, and refuses excessive size before requesting an intent",async()=>{
    const disguised=new File(["%PDF-1.7"],"TEST.png",{type:"image/png"});
    await expect(uploadDevelopmentMaterial("sources/TEST/development",disguised,"款图",100)).rejects.toThrow("PDF 请放在菲林");
    await expect(uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",1)).rejects.toThrow("上传上限");
    expect(request).not.toHaveBeenCalled();
    mockReady();vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true}));
    await expect(uploadDevelopmentMaterial("sources/TEST/development",disguised,"菲林",100)).resolves.toBe(intent.attachmentId);
    expect(request.mock.calls[0]![2]).toMatchObject({mimeType:"application/pdf",filename:"TEST.pdf"});
  });
});

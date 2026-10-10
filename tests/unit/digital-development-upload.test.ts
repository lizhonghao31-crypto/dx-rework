import { afterEach, describe, expect, it, vi } from "vitest";
import { digitalRequest } from "../../apps/web/src/digital-production-api.js";
import { uploadDevelopmentMaterial } from "../../apps/web/src/digital-development-upload.js";
vi.mock("../../apps/web/src/digital-production-api.js",()=>({digitalRequest:vi.fn()}));
const request=vi.mocked(digitalRequest);
const png=()=>new File([new Uint8Array([137,80,78,71,13,10,26,10])],"TEST.png",{type:"image/png"});
const intent={attachmentId:"11111111-1111-4111-8111-111111111111",uploadMethod:"POST",uploadUrl:"http://127.0.0.1/fixture-upload",uploadFields:{key:"TEST"}};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();request.mockReset();});
describe("development uploads reuse the existing intent and finalization boundary",()=>{
  it("finalizes a successful original once and returns its same attachment ID",async()=>{
    request.mockResolvedValueOnce(intent).mockResolvedValueOnce({});
    const upload=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal("fetch",upload);
    expect(await uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",100)).toBe(intent.attachmentId);
    expect(request).toHaveBeenNthCalledWith(2,`sources/TEST/development/attachments/${intent.attachmentId}/finalize`,"POST",{});
    expect((upload.mock.calls[0]![1].body as FormData).get("file")).toMatchObject({name:"TEST.png",size:8});
  });
  it("keeps failed upload unfinalized with a retry instruction, then succeeds through the same public operation",async()=>{
    request.mockResolvedValue(intent);
    const upload=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true});vi.stubGlobal("fetch",upload);
    await expect(uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",100)).rejects.toThrow("其它资料仍保留");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",100)).resolves.toBe(intent.attachmentId);
    expect(request.mock.calls.filter(call=>call[0].endsWith("/finalize"))).toHaveLength(1);
  });
  it("rejects PDF bytes disguised as a style image, keeps PDF legal for film, and refuses excessive size before requesting an intent",async()=>{
    const disguised=new File(["%PDF-1.7"],"TEST.png",{type:"image/png"});
    await expect(uploadDevelopmentMaterial("sources/TEST/development",disguised,"款图",100)).rejects.toThrow("PDF 请放在菲林");
    await expect(uploadDevelopmentMaterial("sources/TEST/development",png(),"款图",1)).rejects.toThrow("上传上限");
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(intent).mockResolvedValueOnce({});vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true}));
    await expect(uploadDevelopmentMaterial("sources/TEST/development",disguised,"菲林",100)).resolves.toBe(intent.attachmentId);
    expect(request.mock.calls[0]![2]).toMatchObject({mimeType:"application/pdf",filename:"TEST.pdf"});
  });
});

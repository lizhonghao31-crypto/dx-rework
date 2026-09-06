import concurrent.futures,datetime,hashlib,json,os,sys,urllib.request,urllib.parse,urllib.error
from pathlib import Path

if len(sys.argv)!=3:raise SystemExit('Usage: python3 scripts/sample-verify-objects.py INVENTORY.json NEW_OUTPUT_DIRECTORY')
inventory=json.loads(Path(sys.argv[1]).read_text())
destination=Path(sys.argv[2]);destination.mkdir(mode=0o700,exist_ok=False)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('redirect rejected')
opener=urllib.request.build_opener(NoRedirect())
def check(entry):
 key=entry['objectKey'];identity=hashlib.sha256(key.encode()).hexdigest();result={'objectKey':key,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 try:
  if not key.startswith('daxing-sample/') or any(part in ('','.','..') for part in key.split('/')):raise ValueError('unsafe object key')
  request=urllib.request.Request('https://staging-api.dxerp.org.cn/sample/api/media/sign',data=json.dumps({'objectKey':key}).encode(),headers={'Content-Type':'application/json'},method='POST')
  with opener.open(request,timeout=30) as response:grant=json.load(response)
  link=grant['data']['previewUrl'];url=urllib.parse.urlparse(link)
  if url.username or url.password or url.port or url.scheme!='https' or url.hostname!='daxing-sample-media.oss-cn-hangzhou.aliyuncs.com' or urllib.parse.unquote(url.path[1:])!=key:raise ValueError('unexpected signed origin')
  with opener.open(link,timeout=45) as response:
   data=response.read(20*1024*1024+1)
   if len(data)>20*1024*1024:raise ValueError('object exceeds attachment limit')
  mime='image/jpeg' if data.startswith(b'\xff\xd8\xff') else 'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'image/webp' if data[:4]==b'RIFF' and data[8:12]==b'WEBP' else 'application/pdf' if data.startswith(b'%PDF-') else None
  if not mime:raise ValueError('unsupported object bytes')
  path=destination/(identity+'.bin');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
  with os.fdopen(fd,'wb') as f:f.write(data)
  return {**result,'status':'verified','sizeBytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mimeType':mime,'localFile':path.name}
 except urllib.error.HTTPError as error:return {**result,'status':'blocked','code':'HTTP_'+str(error.code)}
 except Exception as error:return {**result,'status':'blocked','code':type(error).__name__}

entries=inventory['attachments']
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:results=list(executor.map(check,entries))
path=destination/'objects.json';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump({'sourceHash':inventory['sourceHash'],'objects':results},f,ensure_ascii=False,indent=2)
print(json.dumps({'total':len(results),'verified':sum(r['status']=='verified' for r in results),'blocked':sum(r['status']=='blocked' for r in results),'errors':sorted(set(r['code'] for r in results if 'code' in r))}))

if any(r["status"]!="verified" for r in results):sys.exit(2)

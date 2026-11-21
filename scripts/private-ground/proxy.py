import ipaddress,select,socket,socketserver,sys,time,threading,os
parent_pid=os.getppid()
def monitor_parent():
 deadline=time.monotonic()+370
 while os.getppid()==parent_pid and time.monotonic()<deadline:time.sleep(0.5)
 os._exit(0)
threading.Thread(target=monitor_parent,daemon=True).start()
allowed={'pro.easyeda.com','image-pro.easyeda.com'}
budget_lock=threading.Lock()
budget={'connections':0,'bytes':0}
MAX_CONNECTIONS=1200
MAX_BYTES=128*1024*1024
limit=threading.BoundedSemaphore(8)
class Handler(socketserver.BaseRequestHandler):
 def handle(self):
  if not limit.acquire(blocking=False):return
  target=None
  try:
   self.request.settimeout(10)
   buf=b''
   while b'\r\n\r\n' not in buf and len(buf)<16384:
    v=self.request.recv(2048)
    if not v:return
    buf+=v
   header,sep,extra=buf.partition(b'\r\n\r\n')
   line=header.split(b'\r\n',1)[0].decode('ascii').split()
   if len(line)!=3 or line[0]!='CONNECT' or ':' not in line[1] or extra:
    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');print('DENY_METHOD',flush=True);return
   host,port=line[1].rsplit(':',1);host=host.lower()
   if host not in allowed or port!='443':
    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');print('DENY_DESTINATION',host[:120],flush=True);return
   with budget_lock:
    if budget['connections']>=MAX_CONNECTIONS or budget['bytes']>=MAX_BYTES: return
    budget['connections']+=1
   for family,kind,proto,_,addr in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM):
    if not ipaddress.ip_address(addr[0]).is_global:continue
    try:
     target=socket.socket(family,kind,proto);target.settimeout(8);target.connect(addr);break
    except OSError:
     if target:target.close()
     target=None
   if not target:raise OSError('No allowed public endpoint')
   print('ALLOW',host,flush=True);self.request.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
   target.settimeout(8);self.request.settimeout(8);deadline=time.monotonic()+80;total=0
   while time.monotonic()<deadline and total<8*1024*1024:
    ready,_,_=select.select([self.request,target],[],[],min(2,max(0,deadline-time.monotonic())))
    for src in ready:
     data=src.recv(65536)
     if not data:return
     with budget_lock:
      if budget['bytes']+len(data)>MAX_BYTES: return
      budget['bytes']+=len(data)
     total+=len(data)
     (target if src is self.request else self.request).sendall(data)
  except (OSError,ValueError,UnicodeError):print('CLOSED_OR_FAILED',flush=True)
  finally:
   if target:target.close()
   limit.release()
class Server(socketserver.ThreadingUnixStreamServer):
 daemon_threads=True
with Server(sys.argv[1],Handler) as server:server.serve_forever()

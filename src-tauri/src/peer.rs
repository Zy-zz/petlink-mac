use crate::protocol::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

const STALE: u64 = 20_000;
type PairCallback = dyn Fn(&str, &str) -> Result<()> + Send + Sync;
type MessageCallback = dyn Fn(Value) -> Result<()> + Send + Sync;
type UpdateCallback = dyn Fn() + Send + Sync;
type ErrorCallback = dyn Fn(String) + Send + Sync;
pub struct Callbacks {
    pub pair: Box<PairCallback>,
    pub message: Box<MessageCallback>,
    pub update: Box<UpdateCallback>,
    pub error: Box<ErrorCallback>,
}
struct Assembly {
    parts: HashMap<usize, String>,
    total: usize,
    mode: String,
    at: u64,
    latest: u64,
}
struct Inner {
    peer: Option<String>,
    name: String,
    can_throw: bool,
    can_quick: bool,
    last_seen: u64,
    pair_notified: bool,
    assemblies: HashMap<String, Assembly>,
    delivered: HashMap<String, u64>,
    controls: HashMap<String, u64>,
    challenges: HashMap<String, u64>,
    completed: VecDeque<String>,
    remote_challenge: Option<String>,
    pending: HashMap<String, oneshot::Sender<()>>,
}
pub struct Peer {
    identity: Identity,
    invite: Invite,
    name: String,
    relays: Vec<String>,
    inner: Mutex<Inner>,
    sockets: Mutex<HashMap<String, mpsc::Sender<String>>>,
    emitted_status: Mutex<Value>,
    cancel: watch::Sender<bool>,
    callbacks: Callbacks,
    send_queue: tokio::sync::Mutex<()>,
}
impl Peer {
    pub fn new(
        identity: Identity,
        invite: &str,
        pinned: Option<String>,
        name: String,
        relays: Vec<String>,
        callbacks: Callbacks,
    ) -> Result<Arc<Self>> {
        identity.validate()?;
        let invite = Invite::parse(invite)?;
        if name.trim().is_empty() || name.encode_utf16().count() > 40 {
            return Err("名称最多 40 个字符".into());
        }
        if let Some(pk) = &pinned {
            pubkey(pk)?;
            if pk == &identity.pubkey {
                return Err("好友身份无效".into());
            }
        }
        let peer = if identity.pubkey != invite.host_pubkey {
            if pinned.as_ref().is_some_and(|pk| pk != &invite.host_pubkey) {
                return Err("好友身份与邀请不匹配".into());
            }
            Some(invite.host_pubkey.clone())
        } else {
            pinned
        };
        if relays.is_empty() || relays.len() > 8 {
            return Err("中继地址无效".into());
        }
        for relay in &relays {
            let u = url::Url::parse(relay).map_err(|_| "中继地址无效")?;
            if !matches!(u.scheme(), "ws" | "wss")
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.fragment().is_some()
            {
                return Err("中继地址无效".into());
            }
        }
        let (cancel, _) = watch::channel(false);
        Ok(Arc::new(Self {
            identity,
            invite,
            name,
            relays,
            sockets: Mutex::new(HashMap::new()),
            emitted_status: Mutex::new(Value::Null),
            cancel,
            callbacks,
            send_queue: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner {
                peer,
                name: String::new(),
                can_throw: false,
                can_quick: false,
                last_seen: 0,
                pair_notified: false,
                assemblies: HashMap::new(),
                delivered: HashMap::new(),
                controls: HashMap::new(),
                challenges: HashMap::new(),
                completed: VecDeque::new(),
                remote_challenge: None,
                pending: HashMap::new(),
            }),
        }))
    }
    pub fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let count = self.sockets.lock().unwrap().len();
        json!({"relayConnected":count,"peerOnline":!*self.cancel.borrow() && count>0 && inner.last_seen>0 && now().saturating_sub(inner.last_seen)<STALE,
            "paired":inner.peer.is_some(),"peerName":inner.name,"peerPubkey":inner.peer,"canThrow":inner.can_throw,"canQuickActions":inner.can_quick})
    }
    fn notify_status(&self) {
        let current = self.status();
        let changed = {
            let mut previous = self.emitted_status.lock().unwrap();
            if *previous == current {
                false
            } else {
                *previous = current;
                true
            }
        };
        if changed {
            (self.callbacks.update)();
        }
    }
    pub fn start(self: &Arc<Self>) {
        for url in &self.relays {
            let p = self.clone();
            let url = url.clone();
            tokio::spawn(async move {
                p.connect(url).await;
            });
        }
        let p = self.clone();
        tokio::spawn(async move {
            let mut stop = p.cancel.subscribe();
            let mut timer = tokio::time::interval(Duration::from_secs(5));
            loop {
                tokio::select! {
                    _=stop.changed()=>break,
                    _=timer.tick()=>{
                        { let mut i=p.inner.lock().unwrap(); let at=now();
                          i.assemblies.retain(|_,a|at.saturating_sub(a.at)<60000);
                          i.delivered.retain(|_,t|at.saturating_sub(*t)<180000);
                          i.controls.retain(|_,t|at.saturating_sub(*t)<180000);
                          i.challenges.retain(|_,t|at.saturating_sub(*t)<STALE); }
                        if let Err(e)=p.hello().await { (p.callbacks.error)(e); }
                        p.notify_status();
                    }
                }
            }
        });
    }
    pub fn stop(&self) {
        self.cancel.send_replace(true);
        self.sockets.lock().unwrap().clear();
        let mut i = self.inner.lock().unwrap();
        i.pending.clear();
        i.last_seen = 0;
    }
    pub async fn goodbye(&self) {
        let challenge = self.inner.lock().unwrap().remote_challenge.clone();
        if let Some(challenge) = challenge {
            let _ = self
                .publish(
                    json!({"type":"bye","challenge":challenge,"at":now()}),
                    "pair",
                    u64::MAX,
                )
                .await;
        }
        self.stop();
    }
    async fn connect(self: Arc<Self>, url: String) {
        let mut stop = self.cancel.subscribe();
        while !*stop.borrow() {
            let config = WebSocketConfig::default()
                .max_message_size(Some(32000))
                .max_frame_size(Some(32000));
            let connection = tokio::select! { _=stop.changed()=>break,
            r=tokio::time::timeout(Duration::from_secs(10),connect_async_with_config(&url,Some(config),false))=>r };
            if let Ok(Ok((mut ws, _))) = connection {
                let req=json!(["REQ","petlink",{"kinds":[KIND],"#x":[self.invite.topic],"since":now()/1000-120}]).to_string();
                if ws.send(Message::Text(req.into())).await.is_ok() {
                    let (tx, mut rx) = mpsc::channel::<String>(32);
                    self.sockets.lock().unwrap().insert(url.clone(), tx);
                    self.notify_status();
                    let _ = self.hello().await;
                    loop {
                        tokio::select! {
                            _=stop.changed()=>{ let _=ws.close(None).await; break; },
                            outgoing=rx.recv()=>{
                                let Some(outgoing)=outgoing else { break; };
                                if !matches!(tokio::time::timeout(Duration::from_secs(10),ws.send(Message::Text(outgoing.into()))).await,Ok(Ok(()))) { break; }
                            },
                            frame=ws.next()=>{
                                match frame {
                                    Some(Ok(Message::Text(text)))=>{
                                        if let Ok(frame)=serde_json::from_str::<Value>(&text) {
                                            if frame[0]=="EVENT" && frame[1]=="petlink" {
                                                let actions=self.receive(&frame[2]);
                                                for (packet,mode) in actions { let _=self.publish(packet,&mode,u64::MAX).await; }
                                                self.notify_status();
                                            }
                                        }
                                    },
                                    Some(Ok(Message::Close(_)))|Some(Err(_))|None=>break,
                                    _=>{}
                                }
                            }
                        }
                    }
                }
            }
            self.sockets.lock().unwrap().remove(&url);
            self.notify_status();
            tokio::select! { _=stop.changed()=>break, _=tokio::time::sleep(Duration::from_secs(3))=>{} }
        }
    }
    async fn hello(&self) -> Result<()> {
        if *self.cancel.borrow() || self.sockets.lock().unwrap().is_empty() {
            return Ok(());
        }
        let peer = self.inner.lock().unwrap().peer.clone();
        self.publish(json!({"type":"hello","name":self.name,"target":peer,"features":["throw-v1","quick-v1"],"at":now()}),"hello",u64::MAX).await
    }
    async fn publish(&self, packet: Value, mode: &str, deadline: u64) -> Result<()> {
        let peer = self.inner.lock().unwrap().peer.clone();
        let key = self.invite.key(&self.identity, mode, peer.as_deref())?;
        let encoded = seal(&packet, &key, &self.invite.topic, mode)?;
        let id = uuid::Uuid::new_v4().to_string();
        let total = encoded.len().div_ceil(CHUNK);
        for (part, data) in encoded.as_bytes().chunks(CHUNK).enumerate() {
            if *self.cancel.borrow() {
                return Err("连接已关闭，消息未确认送达".into());
            }
            if now() >= deadline {
                return Err("对方未确认收到消息，请检查双方连接后重试".into());
            }
            let event = sign_event(
                &self.identity,
                &self.invite.topic,
                json!({"v":1,"id":id,"part":part,"total":total,"mode":mode,"data":std::str::from_utf8(data).unwrap()}),
            )?;
            let frame = json!(["EVENT", event]).to_string();
            let mut count = 0;
            {
                let mut sockets = self.sockets.lock().unwrap();
                sockets.retain(|_, tx| {
                    if tx.try_send(frame.clone()).is_ok() {
                        count += 1;
                        true
                    } else {
                        false
                    }
                });
            }
            if count == 0 {
                return Err("中继未连接，消息未送达".into());
            }
            if total > 1 {
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        }
        Ok(())
    }
    fn receive(&self, event: &Value) -> Vec<(Value, String)> {
        let mut actions = Vec::new();
        let result = (|| -> Result<()> {
            let at = now();
            let sender = event["pubkey"].as_str().ok_or("公钥无效")?;
            let mut i = self.inner.lock().unwrap();
            if event["kind"] != KIND
                || sender == self.identity.pubkey
                || !hex32(sender)
                || event["content"].as_str().is_none_or(|s| s.len() > 24000)
                || event["tags"] != json!([["x", self.invite.topic]])
                || event["created_at"]
                    .as_u64()
                    .is_none_or(|t| (at / 1000).abs_diff(t) > 120)
                || i.peer.as_ref().is_some_and(|pk| pk != sender)
                || !verify_event(event)
            {
                return Ok(());
            }
            let f: Value =
                serde_json::from_str(event["content"].as_str().unwrap()).map_err(|_| "分片无效")?;
            let id = f["id"].as_str().ok_or("分片无效")?;
            let mode = f["mode"].as_str().ok_or("分片无效")?;
            let total = f["total"].as_u64().ok_or("分片无效")? as usize;
            let part = f["part"].as_u64().ok_or("分片无效")? as usize;
            let data = f["data"].as_str().ok_or("分片无效")?;
            if f["v"] != 1
                || !valid_id(id)
                || !matches!(mode, "hello" | "pair")
                || !(1..=MAX_PARTS).contains(&total)
                || part >= total
                || data.is_empty()
                || data.len() > CHUNK
                || !data
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"+/=".contains(&c))
                || (mode == "hello" && total != 1)
                || (mode == "pair" && i.peer.is_none())
            {
                return Ok(());
            }
            let key = format!("{sender}:{id}");
            if !i.assemblies.contains_key(&key) && i.assemblies.len() >= 4 {
                return Ok(());
            }
            let a = i.assemblies.entry(key.clone()).or_insert_with(|| Assembly {
                parts: HashMap::new(),
                total,
                mode: mode.into(),
                at,
                latest: 0,
            });
            if a.total != total || a.mode != mode {
                return Ok(());
            }
            a.latest = a.latest.max(event["created_at"].as_u64().unwrap());
            a.parts.entry(part).or_insert_with(|| data.into());
            if a.parts.len() != total {
                return Ok(());
            }
            let a = i.assemblies.remove(&key).unwrap();
            let encoded = (0..total).map(|n| a.parts[&n].as_str()).collect::<String>();
            let packet = unseal(
                &encoded,
                &self.invite.key(&self.identity, mode, Some(sender))?,
                &self.invite.topic,
                mode,
            )?;
            if packet["at"]
                .as_u64()
                .is_none_or(|t| at.abs_diff(t) > 120000)
            {
                return Ok(());
            }
            if packet["type"] != "message" {
                if i.controls.contains_key(&key) || i.controls.len() >= 2000 {
                    return Ok(());
                }
                i.controls.insert(key, at);
            }
            if packet["type"] == "hello" && mode == "hello" {
                let name = packet["name"].as_str().ok_or("名称无效")?;
                if name.trim().is_empty()
                    || name.encode_utf16().count() > 40
                    || (!packet["target"].is_null() && packet["target"] != self.identity.pubkey)
                    || (i.peer.is_none() && packet["target"] != self.identity.pubkey)
                {
                    return Ok(());
                }
                if !i.pair_notified {
                    (self.callbacks.pair)(sender, name)?;
                    i.peer = Some(sender.into());
                    i.pair_notified = true;
                    actions.push((json!({"type":"hello","name":self.name,"target":sender,"features":["throw-v1","quick-v1"],"at":at}),"hello".into()));
                }
                i.name = name.into();
                i.can_throw = packet["features"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("throw-v1")));
                i.can_quick = packet["features"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!("quick-v1")));
                if i.challenges.len() < 8 {
                    let challenge = uuid::Uuid::new_v4().to_string();
                    i.challenges.insert(challenge.clone(), at);
                    actions.push((
                        json!({"type":"ping","challenge":challenge,"at":at}),
                        "pair".into(),
                    ));
                }
            } else if mode == "pair" && i.peer.as_deref() == Some(sender) {
                let recent = (at / 1000).abs_diff(a.latest) < STALE / 1000;
                let fresh = i.last_seen > 0 && recent;
                let challenge = packet["challenge"].as_str().filter(|s| valid_id(s));
                match packet["type"].as_str() {
                    Some("ping") if challenge.is_some() => {
                        let c = challenge.unwrap();
                        if recent {
                            i.remote_challenge = Some(c.into());
                        }
                        if fresh {
                            i.last_seen = at;
                        }
                        actions.push((json!({"type":"pong","challenge":c,"at":at}), "pair".into()));
                    }
                    Some("pong")
                        if challenge.is_some_and(|c| {
                            i.challenges
                                .get(c)
                                .is_some_and(|t| at.saturating_sub(*t) < STALE)
                        }) =>
                    {
                        let c = challenge.unwrap();
                        i.challenges.remove(c);
                        i.completed.push_back(c.into());
                        if i.completed.len() > 8 {
                            i.completed.pop_front();
                        }
                        i.last_seen = at;
                    }
                    Some("bye")
                        if challenge.is_some_and(|c| i.completed.iter().any(|s| s == c)) =>
                    {
                        i.last_seen = 0;
                        i.challenges.clear();
                        i.completed.clear();
                        i.remote_challenge = None;
                    }
                    Some("ack") => {
                        if let Some(id) = packet["id"].as_str().filter(|s| valid_id(s)) {
                            if let Some(tx) = i.pending.remove(id) {
                                if fresh {
                                    i.last_seen = at;
                                }
                                let _ = tx.send(());
                            }
                        }
                    }
                    Some("message") => {
                        let message = validate_message(&packet["message"], at)?;
                        let id = message["id"].as_str().ok_or("消息 ID 无效")?;
                        if message["sentAt"].is_null() || message["fromName"].is_null() {
                            return Ok(());
                        }
                        if !i.delivered.contains_key(id) {
                            if i.delivered.len() >= 2000 {
                                return Ok(());
                            }
                            // The callback must commit to disk before this receiver sends an ACK.
                            (self.callbacks.message)(message.clone())?;
                            i.delivered.insert(id.into(), at);
                            if fresh {
                                i.last_seen = at;
                            }
                        }
                        actions.push((json!({"type":"ack","id":id,"at":at}), "pair".into()));
                    }
                    _ => {}
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            if !matches!(
                error.as_str(),
                "分片无效" | "密文无效" | "密文认证失败" | "消息格式无效"
            ) {
                (self.callbacks.error)(error);
            }
        }
        actions
    }
    pub async fn send(&self, input: Value) -> Result<Value> {
        let _guard = self.send_queue.lock().await;
        let mut message = validate_message(&input, now())?;
        if self.status()["peerOnline"] != true {
            return Err("好友离线，请等对方上线后再发送".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        message["id"] = json!(id);
        message["sentAt"] = json!(now());
        message["fromName"] = json!(self.name);
        let (tx, mut rx) = oneshot::channel();
        self.inner.lock().unwrap().pending.insert(id.clone(), tx);
        let mut stop = self.cancel.subscribe();
        let deadline = now() + 45000;
        let result=async {
            loop {
                self.publish(json!({"type":"message","message":message,"at":now()}),"pair",deadline).await?;
                let wait=Duration::from_millis((deadline.saturating_sub(now())).min(4000));
                tokio::select! {
                    r=&mut rx=>return r.map(|_|message.clone()).map_err(|_|"连接已关闭，消息未确认送达".into()),
                    _=stop.changed()=>return Err("连接已关闭，消息未确认送达".into()),
                    _=tokio::time::sleep(wait)=>{}
                }
                if now()>=deadline { return Err("对方未确认收到消息，请检查双方连接后重试".into()); }
            }
        }.await;
        self.inner.lock().unwrap().pending.remove(&id);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn fixture(fail: bool) -> (Arc<Peer>, Identity, Invite, Arc<AtomicUsize>) {
        let host = Identity::create();
        let remote = Identity::create();
        let encoded = Invite::create(&host);
        let invite = Invite::parse(&encoded).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let p = Peer::new(
            host,
            &encoded,
            Some(remote.pubkey.clone()),
            "Host".into(),
            vec!["ws://127.0.0.1:1".into()],
            Callbacks {
                pair: Box::new(|_, _| Ok(())),
                message: Box::new(move |_| {
                    c.fetch_add(1, Ordering::SeqCst);
                    if fail {
                        Err("disk full".into())
                    } else {
                        Ok(())
                    }
                }),
                update: Box::new(|| {}),
                error: Box::new(|_| {}),
            },
        )
        .unwrap();
        (p, remote, invite, count)
    }
    fn event(p: &Peer, remote: &Identity, invite: &Invite, packet: Value, mode: &str) -> Value {
        let key = invite.key(remote, mode, Some(&p.identity.pubkey)).unwrap();
        let data = seal(&packet, &key, &invite.topic, mode).unwrap();
        sign_event(remote,&invite.topic,json!({"v":1,"id":uuid::Uuid::new_v4().to_string(),"part":0,"total":1,"mode":mode,"data":data})).unwrap()
    }
    #[test]
    fn receiver_requires_persistence_before_ack_and_deduplicates() {
        let (p, remote, invite, count) = fixture(false);
        let id = uuid::Uuid::new_v4().to_string();
        let packet = json!({"type":"message","at":now(),"message":{"id":id,"sentAt":now(),"fromName":"Remote","text":"hello"}});
        let first = p.receive(&event(&p, &remote, &invite, packet.clone(), "pair"));
        assert_eq!(first[0].0["type"], "ack");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let retry = p.receive(&event(&p, &remote, &invite, packet, "pair"));
        assert_eq!(retry[0].0["type"], "ack");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let (p, remote, invite, count) = fixture(true);
        let packet = json!({"type":"message","at":now(),"message":{"id":uuid::Uuid::new_v4().to_string(),"sentAt":now(),"fromName":"Remote","text":"hello"}});
        assert!(p
            .receive(&event(&p, &remote, &invite, packet.clone(), "pair"))
            .is_empty());
        assert!(p.inner.lock().unwrap().delivered.is_empty());
        assert!(p
            .receive(&event(&p, &remote, &invite, packet, "pair"))
            .is_empty());
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn receiver_rejects_tampering_third_parties_and_replayed_presence() {
        let (p, remote, invite, count) = fixture(false);
        let hello = json!({"type":"hello","at":now(),"name":"Remote","target":p.identity.pubkey,"features":["throw-v1","quick-v1"]});
        let e = event(&p, &remote, &invite, hello.clone(), "hello");
        let actions = p.receive(&e);
        assert!(actions.iter().any(|(a, _)| a["type"] == "ping"));
        assert_eq!(p.status()["peerOnline"], false);
        assert!(p.receive(&e).is_empty());
        let stranger = Identity::create();
        assert!(p
            .receive(&event(&p, &stranger, &invite, hello, "hello"))
            .is_empty());
        let challenge =
            actions.iter().find(|(a, _)| a["type"] == "ping").unwrap().0["challenge"].clone();
        p.receive(&event(
            &p,
            &remote,
            &invite,
            json!({"type":"pong","at":now(),"challenge":challenge}),
            "pair",
        ));
        assert!(p.inner.lock().unwrap().last_seen > 0);
        let mut tampered = event(
            &p,
            &remote,
            &invite,
            json!({"type":"bye","at":now(),"challenge":challenge}),
            "pair",
        );
        tampered["sig"] = json!("0".repeat(128));
        assert!(p.receive(&tampered).is_empty());
        assert!(p.inner.lock().unwrap().last_seen > 0);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let bye = event(
            &p,
            &remote,
            &invite,
            json!({"type":"bye","at":now(),"challenge":challenge}),
            "pair",
        );
        p.receive(&bye);
        assert_eq!(p.inner.lock().unwrap().last_seen, 0);
        assert!(p.receive(&bye).is_empty());
    }
}

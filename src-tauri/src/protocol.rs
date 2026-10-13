use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use hkdf::Hkdf;
use rand::RngCore;
use secp256k1::{
    ecdh::shared_secret_point, schnorr::Signature, Keypair, PublicKey, Secp256k1, SecretKey,
    XOnlyPublicKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const KIND: u64 = 24747;
pub const MAX_FILE: usize = 5 * 1024 * 1024;
pub const MAX_PACKET: usize = MAX_FILE.div_ceil(3) * 4 + 32000;
pub const CHUNK: usize = 23000;
pub const MAX_PARTS: usize = ((MAX_PACKET + 32) * 4).div_ceil(3).div_ceil(CHUNK);
pub const DEFAULT_RELAYS: [&str; 3] = [
    "wss://nos.lol",
    "wss://nostr.mom",
    "wss://relay.snort.social",
];
pub type Result<T> = std::result::Result<T, String>;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn hex32(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn valid_id(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
pub fn pubkey(s: &str) -> Result<XOnlyPublicKey> {
    if !hex32(s) {
        return Err("客户端身份无效".into());
    }
    s.parse().map_err(|_| "客户端身份无效".into())
}
fn secret(s: &str) -> Result<SecretKey> {
    if !hex32(s) {
        return Err("客户端身份无效".into());
    }
    s.parse().map_err(|_| "客户端身份无效".into())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub secret_key: String,
    pub pubkey: String,
}
impl Identity {
    pub fn create() -> Self {
        let sk = SecretKey::new(&mut rand::rng());
        let kp = Keypair::from_secret_key(&Secp256k1::new(), &sk);
        Self {
            secret_key: sk.display_secret().to_string(),
            pubkey: kp.x_only_public_key().0.to_string(),
        }
    }
    pub fn validate(&self) -> Result<()> {
        let kp = Keypair::from_secret_key(&Secp256k1::new(), &secret(&self.secret_key)?);
        if kp.x_only_public_key().0.to_string() != self.pubkey {
            return Err("客户端身份无效".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub secret: String,
    pub host_pubkey: String,
    #[serde(skip)]
    pub topic: String,
}
impl Invite {
    pub fn create(identity: &Identity) -> String {
        let mut bytes = [0; 32];
        rand::rng().fill_bytes(&mut bytes);
        format!(
            "PL1.{}",
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(
                    &json!({"secret":hex::encode(bytes),"hostPubkey":identity.pubkey})
                )
                .unwrap()
            )
        )
    }
    pub fn parse(input: &str) -> Result<Self> {
        let invalid = || "邀请无效，请复制完整的 PL1 邀请码".to_string();
        if input.len() > 512 {
            return Err(invalid());
        }
        let encoded = input.trim().strip_prefix("PL1.").ok_or_else(invalid)?;
        let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
        if URL_SAFE_NO_PAD.encode(&bytes) != encoded {
            return Err(invalid());
        }
        let mut invite: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !hex32(&invite.secret) || pubkey(&invite.host_pubkey).is_err() {
            return Err(invalid());
        }
        invite.topic = hex::encode(Sha256::digest(format!("petlink-v1:{}", invite.secret)));
        Ok(invite)
    }
    pub fn key(&self, identity: &Identity, mode: &str, peer: Option<&str>) -> Result<[u8; 32]> {
        let room: [u8; 32] = hex::decode(&self.secret)
            .map_err(|_| "邀请无效")?
            .try_into()
            .map_err(|_| "邀请无效")?;
        if mode == "hello" {
            return Ok(room);
        }
        let pk = pubkey(peer.ok_or("尚未配对")?)?;
        let shared = shared_secret_point(
            &PublicKey::from_x_only_public_key(pk, secp256k1::Parity::Even),
            &secret(&identity.secret_key)?,
        );
        let mut key = [0; 32];
        Hkdf::<Sha256>::new(Some(&room), &shared[..32])
            .expand(b"petlink-v1-pair", &mut key)
            .map_err(|_| "密钥派生失败")?;
        Ok(key)
    }
}

pub fn validate_placement(v: &Value) -> Result<Value> {
    if v["display"].as_u64().is_none_or(|d| !(1..=16).contains(&d))
        || ["x", "y"].iter().any(|k| {
            v[k].as_f64()
                .is_none_or(|n| !n.is_finite() || !(0.0..=1.0).contains(&n))
        })
    {
        return Err("落点无效，请重新选择屏幕位置".into());
    }
    Ok(json!({"display":v["display"],"x":v["x"],"y":v["y"]}))
}
pub fn image_mime(s: &str) -> bool {
    matches!(s, "image/png" | "image/jpeg" | "image/webp" | "image/gif")
}
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
pub fn validate_message(input: &Value, timestamp: u64) -> Result<Value> {
    if !input.is_object() {
        return Err("消息格式无效".into());
    }
    let text = if input["text"].is_null() {
        ""
    } else {
        input["text"].as_str().ok_or("文字最多 4000 个字符")?
    };
    if utf16_len(text) > 4000 {
        return Err("文字最多 4000 个字符".into());
    }
    let mut out = json!({"text":text});
    if !input["attachment"].is_null() {
        let a = &input["attachment"];
        let invalid = "附件格式无效，最大 5 MiB";
        let name = a["name"].as_str().ok_or(invalid)?;
        let mime = a["mime"].as_str().ok_or(invalid)?;
        let data = a["data"].as_str().ok_or(invalid)?;
        let valid_mime = mime.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
        });
        if name.trim().is_empty()
            || utf16_len(name) > 255
            || name.chars().any(|c| c <= '\u{1f}' || c == '/' || c == '\\')
            || mime.len() > 128
            || !valid_mime
            || data.len() > MAX_FILE.div_ceil(3) * 4
        {
            return Err(invalid.into());
        }
        let bytes = STANDARD.decode(data).map_err(|_| invalid)?;
        if bytes.is_empty() || bytes.len() > MAX_FILE || STANDARD.encode(&bytes) != data {
            return Err(invalid.into());
        }
        out["attachment"] = json!({"name":name,"mime":mime,"data":data});
    }
    if input.get("placement").is_some() {
        out["placement"] = validate_placement(&input["placement"])?;
        if !out["attachment"].is_null()
            && !image_mime(out["attachment"]["mime"].as_str().unwrap_or(""))
        {
            return Err("甩东西目前支持文字和 PNG / JPEG / WebP / GIF 图片".into());
        }
    }
    if let Some(d) = input.get("throwDecision") {
        if !d["requestId"].as_str().is_some_and(valid_id)
            || !d["accepted"].is_boolean()
            || out.get("placement").is_some()
            || out.get("attachment").is_some()
        {
            return Err("甩东西确认消息无效".into());
        }
        out["throwDecision"] = json!({"requestId":d["requestId"],"accepted":d["accepted"]});
    }
    if let Some(action) = input.get("quickAction") {
        if !matches!(action.as_str(), Some("heart" | "poop" | "walk"))
            || !text.trim().is_empty()
            || ["attachment", "placement", "throwDecision"]
                .iter()
                .any(|k| out.get(k).is_some())
        {
            return Err("快捷互动无效".into());
        }
        out["quickAction"] = action.clone();
    }
    if text.trim().is_empty()
        && ["attachment", "throwDecision", "quickAction"]
            .iter()
            .all(|k| out.get(k).is_none())
    {
        return Err("请输入文字或添加附件".into());
    }
    if !input["id"].is_null() {
        if !input["id"].as_str().is_some_and(valid_id) {
            return Err("消息 ID 无效".into());
        }
        out["id"] = input["id"].clone();
    }
    if !input["sentAt"].is_null() {
        if input["sentAt"]
            .as_u64()
            .is_none_or(|n| n > 9_007_199_254_740_991 || timestamp.abs_diff(n) > 120000)
        {
            return Err("消息已过期".into());
        }
        out["sentAt"] = input["sentAt"].clone();
    }
    if !input["fromName"].is_null() {
        let name = input["fromName"].as_str().ok_or("发送者名称无效")?;
        if name.trim().is_empty() || utf16_len(name) > 40 {
            return Err("发送者名称无效".into());
        }
        out["fromName"] = input["fromName"].clone();
    }
    Ok(out)
}

pub fn seal(packet: &Value, key: &[u8; 32], topic: &str, mode: &str) -> Result<String> {
    let mut nonce = [0; 12];
    rand::rng().fill_bytes(&mut nonce);
    let bytes = serde_json::to_vec(packet).map_err(|e| e.to_string())?;
    let encrypted = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &bytes,
                aad: format!("{topic}:{mode}").as_bytes(),
            },
        )
        .map_err(|_| "加密失败")?;
    let mut sealed = nonce.to_vec();
    sealed.extend_from_slice(&encrypted[encrypted.len() - 16..]);
    sealed.extend_from_slice(&encrypted[..encrypted.len() - 16]);
    Ok(STANDARD.encode(sealed))
}
pub fn unseal(encoded: &str, key: &[u8; 32], topic: &str, mode: &str) -> Result<Value> {
    let sealed = STANDARD.decode(encoded).map_err(|_| "密文无效")?;
    if sealed.len() < 29 || sealed.len() > MAX_PACKET + 28 || STANDARD.encode(&sealed) != encoded {
        return Err("密文无效".into());
    }
    let mut bytes = sealed[28..].to_vec();
    bytes.extend_from_slice(&sealed[12..28]);
    let plain = Aes256Gcm::new(key.into())
        .decrypt(
            Nonce::from_slice(&sealed[..12]),
            Payload {
                msg: &bytes,
                aad: format!("{topic}:{mode}").as_bytes(),
            },
        )
        .map_err(|_| "密文认证失败")?;
    serde_json::from_slice(&plain).map_err(|_| "消息格式无效".into())
}
fn event_id(event: &Value) -> Result<[u8; 32]> {
    let serialized = serde_json::to_vec(&json!([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ]))
    .map_err(|e| e.to_string())?;
    Ok(Sha256::digest(serialized).into())
}
pub fn sign_event(identity: &Identity, topic: &str, content: Value) -> Result<Value> {
    let mut event = json!({"pubkey":identity.pubkey,"created_at":now()/1000,"kind":KIND,"tags":[["x",topic]],"content":content.to_string()});
    let id = event_id(&event)?;
    let kp = Keypair::from_secret_key(&Secp256k1::new(), &secret(&identity.secret_key)?);
    event["id"] = json!(hex::encode(id));
    event["sig"] = json!(Secp256k1::new().sign_schnorr(&id, &kp).to_string());
    Ok(event)
}
pub fn verify_event(event: &Value) -> bool {
    let result = (|| -> Result<()> {
        let id = event_id(event)?;
        if event["id"].as_str() != Some(&hex::encode(id)) {
            return Err("事件 ID 无效".into());
        }
        let pk = pubkey(event["pubkey"].as_str().ok_or("公钥无效")?)?;
        let signature: Signature = event["sig"]
            .as_str()
            .ok_or("签名无效")?
            .parse()
            .map_err(|_| "签名无效")?;
        Secp256k1::new()
            .verify_schnorr(&signature, &id, &pk)
            .map_err(|_| "签名无效".into())
    })();
    result.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_boundaries() {
        let a = Identity::create();
        let b = Identity::create();
        let invite = Invite::parse(&Invite::create(&a)).unwrap();
        a.validate().unwrap();
        let ka = invite.key(&a, "pair", Some(&b.pubkey)).unwrap();
        assert_eq!(ka, invite.key(&b, "pair", Some(&a.pubkey)).unwrap());
        let packet = json!({"type":"message","at":now(),"message":{"text":"你好 🐾"}});
        let sealed = seal(&packet, &ka, &invite.topic, "pair").unwrap();
        assert_eq!(unseal(&sealed, &ka, &invite.topic, "pair").unwrap(), packet);
        assert!(unseal(&sealed, &ka, &invite.topic, "hello").is_err());
        let mut event = sign_event(&a, &invite.topic, json!({"data":sealed})).unwrap();
        assert!(verify_event(&event));
        event["content"] = json!("tampered");
        assert!(!verify_event(&event));
        assert!(validate_message(&json!({"text":"🐾".repeat(2001)}), now()).is_err());
        assert!(validate_message(
            &json!({"attachment":{"name":"../x","mime":"application/octet-stream","data":"YQ=="}}),
            now()
        )
        .is_err());
        assert!(validate_message(
            &json!({"attachment":{"name":"x","mime":"image/png","data":"YQ="}}),
            now()
        )
        .is_err());
        assert!(validate_message(
            &json!({"text":"hi","placement":{"display":1,"x":1.1,"y":0}}),
            now()
        )
        .is_err());
        assert!(validate_message(&json!({"quickAction":"heart","text":"extra"}), now()).is_err());
    }
}

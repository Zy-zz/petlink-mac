// Integration harness: uses the production protocol, connection and persistent store.
use petlink::{
    peer::{Callbacks, Peer},
    protocol::*,
    store::Store,
};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
fn output(value: Value) {
    let mut out = io::stdout().lock();
    writeln!(out, "{}", value).unwrap();
    out.flush().unwrap();
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let store = Arc::new(Mutex::new(Store::load(PathBuf::from(&args[3])).unwrap()));
    let (identity, invite) = {
        let mut s = store.lock().unwrap();
        let identity = s.identity();
        let invite = if args[1] == "host" {
            Invite::create(&identity)
        } else {
            args[4].clone()
        };
        let mut cfg = s.config.clone();
        cfg["name"] = json!("Rust");
        cfg["invite"] = json!(invite);
        s.set_config(cfg).unwrap();
        (identity, invite)
    };
    let pair_store = store.clone();
    let message_store = store.clone();
    let p = Peer::new(
        identity,
        &invite,
        None,
        "Rust".into(),
        args[2].split(',').map(str::to_string).collect(),
        Callbacks {
            pair: Box::new(move |pk, name| {
                pair_store.lock().unwrap().pair(pk, name)?;
                output(json!({"paired":true}));
                Ok(())
            }),
            message: Box::new(move |m| {
                message_store
                    .lock()
                    .unwrap()
                    .remember(m.clone(), "incoming")?;
                output(json!({"received":m}));
                Ok(())
            }),
            update: Box::new(|| {}),
            error: Box::new(|e| output(json!({"error":e}))),
        },
    )
    .unwrap();
    p.start();
    output(json!({"invite":invite}));
    let status_peer = p.clone();
    tokio::spawn(async move {
        let mut previous = Value::Null;
        loop {
            let status = status_peer.status();
            if status != previous {
                output(json!({"status":status}));
                previous = status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(8);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if let Ok(v) = serde_json::from_str(&line) {
                if tx.blocking_send(v).is_err() {
                    break;
                }
            }
        }
    });
    while let Some(command) = rx.recv().await {
        if command["stop"] == true {
            break;
        }
        let result = p.send(command["message"].clone()).await;
        match result {
            Ok(m) => {
                store
                    .lock()
                    .unwrap()
                    .remember(m.clone(), "outgoing")
                    .unwrap();
                output(json!({"rpc":command["rpc"],"sent":m}));
            }
            Err(e) => output(json!({"rpc":command["rpc"],"error":e})),
        }
    }
    p.goodbye().await;
}

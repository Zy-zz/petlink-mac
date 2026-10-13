# REA investigation: lolPing v0.5.1 → PetLink

Target: published Apple Silicon DMG from https://github.com/darrenprx/lolPing/releases/tag/v0.5.1, not an assumed source-tree build.

- DMG SHA-256: `98dbe35ab428de9a8c59d1f6bdd97b1e46e08e818e627c122087b338a2521a88`
- Shipped `app.asar` SHA-256: `43ff642bee1551b3ded37faa49d04d9173f80602e4f6a1deb87870a7bc4d6756`
- REA version: 6.4.0, called through its CLI (same workflows as MCP).
- Application Evidence: `ev_e743d5967e88efbe82ad579cf80f1369ed8fb7c57f85f11f95a0578ad83ffd88`.
- Extraction Evidence: `ev_d2dda4f70af4171f6a6ac5f5c78a281123fb0a1420ac3ee94016a0fbcf330259`; all extracted regular files passed containment checks.
- Window trace: `ev_4fd6259531b65c24c1481c967483df371a5239f6a54cd3fb5147d127e683a011`.
- Room-join trace: `ev_894cd72cd168f136037428a889a36bd53a1ba39402a8c4c04c194981caf21786`.

## Observed in the shipped artifact

REA examined 9 relevant files, parsed 6 JavaScript files, reported 204 findings, two BrowserWindow construction sites, two contextBridge APIs and 60 IPC operations. The artifact graph contains 235 nodes and 267 edges. These are static observations; REA did not run lolPing.

After REA extraction, focused inspection of authenticated `out/main/index.js` established:

1. Lines 3068–3102 construct a transparent frameless overlay, use `screen-saver` always-on-top level, and show it across Mac workspaces/fullscreen. This informed PetLink's small desktop pet and message bubble windows.
2. Lines 1748–1774 derive a room key and use AES-256-GCM for bounded packets. PetLink uses its own paired-identity ECDH/HKDF keys and file fragmentation because lolPing's 1,200-byte packet protocol cannot carry our pictures/files.
3. Lines 2424–2439 and 2862–2867 publish signed kind 24747 events, keyed by an `x` topic, over public Nostr relays. The six packaged relay URLs begin at line 1915; PetLink tested three of them rather than assuming network availability.
4. Lines 3647–3656 handle room create/join/leave via main-process IPC. PetLink also keeps network/keys in the main process and exposes narrowly named operations through a sandboxed preload.

The room-join graph trace selected its actual node ID, matched one seed and traversed two nodes/one edge. The window node trace matched the exact construction site. An earlier literal API seed `setAlwaysOnTop` returned no match; this was not treated as evidence that the method was absent. Focused reads of REA-extracted shipped code supplied the missing detail.

## Limits and recovery

REA's graph marks coverage **partial**, due to dynamic IPC expressions and semantic inference limits. No claim is made that REA recovered the original repository source or every path. The application graph has no parse failures; the semantic graph reports partial/truncated inference and unresolved relations.

The Mac CLI's worker launch initially failed because this machine's Swift SDK and compiler do not match. The same immutable ASAR was analyzed successfully with the same REA 6.4.0 package in a disposable Node 22.22 Linux container, adding procps for REA's process-ownership checks. No system Swift files were changed.

## Commands used

```sh
npx -y rea-agents@latest inspect-artifact /absolute/path/lolPing-0.5.1.asar --json
npx -y rea-agents@latest analyze-javascript-application /absolute/path/lolPing-0.5.1.asar --json
npx -y rea-agents@latest extract-artifact /absolute/path/lolPing-0.5.1.asar --json
npx -y rea-agents@latest trace-application-feature /absolute/path/trace-input.json --json
```

The successful container invocation mounted the artifact under `/analysis` and the already-acquired REA npm package under `/opt/node_modules`. Saved full Evidence is in `lolping-rea-linux-evidence.json`; selected trace input/output JSON and extracted main/preload files remain here for audit.

## Implementation and validation are separate evidence

PetLink's SVG pet and UI are original. The text/image/file protocol, fixed two-person pairing, live presence, recipient acknowledgment, deduplication and persistent local history are PetLink design choices, not recovered lolPing features.

The Electron runtime uses BoringSSL and lacks native secp256k1 ECDH support. Real-client testing caught this; the implementation uses the already-installed noble curve library and verifies that its derived key is byte-identical to the reference Node/OpenSSL result. This is why source-only or Node-only tests were insufficient.

Validation results live in `../test-output/`: protocol tests, two-process UI tests and real public-relay results have distinct scopes. Public-relay tests on this machine do not prove two physical Macs or every network. No Riot Games graphics or sounds are packaged with PetLink.

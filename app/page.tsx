"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Slot = "A" | "B" | "C";
type StagedSlotState = Record<Slot, File | null>;
type DeviceCapture = { status: "installed"; name: string; size: number; format: string; crc: string };
type DeviceSlot = DeviceCapture | { status: "empty" | "invalid" };
type DeviceSlotState = Record<Slot, DeviceSlot>;

const reverbs = [
  { id: "hybrid", name: "Hybrid Space", description: "Articulate room", glyph: "✦" },
  { id: "dattorro", name: "Dattorro", description: "Dense modulated hall", glyph: "◌" },
  { id: "fdn16", name: "FDN-16", description: "Wide diffusion field", glyph: "≈" },
  { id: "reverbsc", name: "ReverbSC", description: "Classic spacious verb", glyph: "⌁" },
];

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textFromHex(value: string) {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) throw new Error("Pedal returned an invalid capture name");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

export default function Home() {
  const [stagedSlots, setStagedSlots] = useState<StagedSlotState>({ A: null, B: null, C: null });
  const [deviceSlots, setDeviceSlots] = useState<DeviceSlotState>({ A: { status: "empty" }, B: { status: "empty" }, C: { status: "empty" } });
  const [up, setUp] = useState("hybrid");
  const [down, setDown] = useState("dattorro");
  const [notice, setNotice] = useState("Ready to connect");
  const [backend, setBackend] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputs = useRef<Record<Slot, HTMLInputElement | null>>({ A: null, B: null, C: null });
  const portRef = useRef<any>(null);
  const installed = useMemo(() => (["A", "B", "C"] as Slot[]).filter((slot) => stagedSlots[slot] || deviceSlots[slot].status === "installed").length, [deviceSlots, stagedSlots]);

  const choose = (slot: Slot, files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(nam|namb)$/i.test(file.name)) {
      setNotice("Choose a .nam or .namb capture file");
      return;
    }
    setStagedSlots((current) => ({ ...current, [slot]: file }));
    setNotice(`${file.name} staged in slot ${slot}`);
  };
  const onDrop = (event: DragEvent<HTMLButtonElement>, slot: Slot) => {
    event.preventDefault();
    choose(slot, event.dataTransfer.files);
  };
  const selectReverb = (position: "up" | "down", next: string) => {
    if (position === "up") {
      const previous = up;
      setUp(next);
      if (next === down) setDown(previous);
    } else {
      const previous = down;
      setDown(next);
      if (next === up) setUp(previous);
    }
  };
  const request = async (command: string, timeout = 7000) => {
    const port = portRef.current;
    if (!port?.writable || !port?.readable) throw new Error("Pedal is not connected");
    const writer = port.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${command}\n`));
    writer.releaseLock();
    const reader = port.readable.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        const wait = Math.max(1, deadline - Date.now());
        const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Pedal did not respond")), wait))]);
        if (result.done) throw new Error("Pedal disconnected");
        received += decoder.decode(result.value, { stream: true });
        const lines = received.split("\n");
        received = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("HNAM ")) continue;
          if (line.startsWith("HNAM ERR ")) throw new Error(line.slice(9).replaceAll("_", " "));
          if (!line.startsWith("HNAM OK ")) throw new Error("Unexpected pedal response");
          return line.slice(8).split(" ");
        }
      }
      throw new Error("Pedal did not respond");
    } finally { reader.releaseLock(); }
  };
  const connectPedal = async () => {
    const serial = (navigator as any).serial;
    if (!serial) { setNotice("Use Chrome or Edge on desktop for direct USB connection"); return; }
    try {
      setBusy(true);
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      const info = await request("HNAM INFO", 4000);
      if (info[0] !== "INFO" || !info[1]) throw new Error("This is not a Hothouse NAM pedal");
      const nextSlots = {} as DeviceSlotState;
      for (const slot of ["A", "B", "C"] as Slot[]) {
        const detail = await request(`HNAM SLOT ${slot}`, 4000);
        if (detail[0] !== "SLOT" || detail[1] !== slot || !["installed", "empty", "invalid"].includes(detail[2])) throw new Error(`Pedal returned invalid metadata for slot ${slot}`);
        if (detail[2] === "installed") {
          if (detail.length < 7) throw new Error(`Pedal returned incomplete metadata for slot ${slot}`);
          nextSlots[slot] = { status: "installed", format: detail[3], size: Number(detail[4]), crc: detail[5], name: textFromHex(detail[6]) };
        } else nextSlots[slot] = { status: detail[2] as "empty" | "invalid" };
      }
      const reverb = await request("HNAM REVERB INFO", 4000);
      const connectedUp = reverb.find((value) => value.startsWith("up="))?.slice(3);
      const connectedDown = reverb.find((value) => value.startsWith("down="))?.slice(5);
      if (connectedUp && connectedDown) { setUp(connectedUp); setDown(connectedDown); }
      setDeviceSlots(nextSlots);
      setBackend(info[1]);
      setNotice(`Connected · ${info[1] === "a1_nano_relu" ? "A1 Nano-ReLU" : "A2-Lite"}`);
    } catch (error) {
      await portRef.current?.close?.().catch(() => undefined);
      portRef.current = null;
      setBackend(null);
      setNotice(error instanceof Error ? error.message : "Unable to connect to pedal");
    } finally { setBusy(false); }
  };
  const sendConfiguration = async () => {
    if (!backend) { await connectPedal(); return; }
    try {
      setBusy(true);
      const current = await request("HNAM REVERB INFO");
      const currentUp = current.find((value) => value.startsWith("up="))?.slice(3);
      let currentDown = current.find((value) => value.startsWith("down="))?.slice(5);
      if (!currentUp || !currentDown) throw new Error("Pedal returned an invalid reverb mapping");
      if (currentDown === up && currentUp !== up) {
        const temporary = reverbs.find((reverb) => reverb.id !== up && reverb.id !== down)?.id;
        if (!temporary) throw new Error("Could not prepare reverb mapping");
        await request(`HNAM REVERB MAP DOWN ${temporary}`);
        currentDown = temporary;
      }
      if (currentUp !== up) await request(`HNAM REVERB MAP UP ${up}`);
      if (currentDown !== down) await request(`HNAM REVERB MAP DOWN ${down}`);
      if (backend !== "a1_nano_relu") {
        setNotice("Reverb mapping sent. Direct A2 capture preparation is coming next.");
        return;
      }
      for (const slot of ["A", "B", "C"] as Slot[]) {
        const file = stagedSlots[slot];
        if (!file) continue;
        if (!file.name.toLowerCase().endsWith(".namb")) throw new Error(`Slot ${slot} needs a .namb file for A1 direct transfer`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > 64 * 1024) throw new Error(`${file.name} exceeds A1's 64 KB limit`);
        const name = file.name.replace(/\.namb$/i, "").slice(0, 63);
        await request(`HNAM BEGIN ${slot} a1_namb ${bytes.byteLength} ${crc32(bytes).toString(16).padStart(8, "0")} ${hex(new TextEncoder().encode(name))}`, 20000);
        for (let offset = 0; offset < bytes.length; offset += 128) {
          const chunk = bytes.slice(offset, offset + 128);
          await request(`HNAM DATA ${offset} ${hex(chunk)}`);
          setNotice(`Sending ${file.name} · ${Math.round(((offset + chunk.length) / bytes.length) * 100)}%`);
        }
        await request("HNAM COMMIT", 15000);
        setDeviceSlots((currentSlots) => ({ ...currentSlots, [slot]: { status: "installed", name, size: bytes.byteLength, format: "a1_namb", crc: crc32(bytes).toString(16).padStart(8, "0") } }));
        setStagedSlots((currentSlots) => ({ ...currentSlots, [slot]: null }));
      }
      setNotice("Configuration sent to pedal");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send configuration"); }
    finally { setBusy(false); }
  };

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Hothouse NAM editor home"><span className="brand-mark">H</span> Hothouse <b>NAM</b></a>
      <div className="connection"><span className="status-dot" /> {backend ? `Connected · ${backend}` : "Pedal not connected"} <button onClick={connectPedal} disabled={busy}>{busy ? "Working…" : backend ? "Reconnect" : "Connect pedal"}</button></div>
    </header>
    <section className="hero" id="top">
      <div><p className="eyebrow">Preset editor <span>•</span> Device 01</p><h1>Current <em>rig</em></h1></div>
      <div className="hero-summary"><b>{installed}/3</b><span>NAM slots loaded</span><div className="progress"><i style={{ width: `${installed * 33.33}%` }} /></div></div>
    </section>
    <section className="workspace" aria-label="Pedal configuration">
      <div className="section-heading"><div><p className="eyebrow">01 / Capture bank</p><h2>NAM captures</h2></div><p>A / B / C match the pedal’s three-position selector.</p></div>
      <div className="slot-grid">
        {(["A", "B", "C"] as Slot[]).map((slot, index) => {
          const file = stagedSlots[slot];
          const deviceSlot = deviceSlots[slot];
          const populated = file || deviceSlot.status === "installed";
          return <article className={`slot-card ${populated ? "has-file" : ""}`} key={slot}>
            <div className="slot-top"><span className="slot-letter">{slot}</span><span className="slot-position">{["UP", "CENTER", "DOWN"][index]}</span></div>
            {file ? <div className="file-loaded"><span className="file-icon">▤</span><div><strong>{file.name.replace(/\.(nam|namb)$/i, "")}</strong><small>STAGED · {file.name.split(".").pop()?.toUpperCase()} · {size(file.size)}</small></div><button className="remove" onClick={() => { setStagedSlots((current) => ({ ...current, [slot]: null })); setNotice(`Slot ${slot} staging cleared`); }} aria-label={`Undo replacement for slot ${slot}`}>×</button></div>
              : deviceSlot.status === "installed" ? <div className="file-loaded"><span className="file-icon">▤</span><div><strong>{deviceSlot.name}</strong><small>ON PEDAL · {deviceSlot.format === "a2_weights_f32" ? "A2-LITE" : "NAMB"} · {size(deviceSlot.size)}</small></div><button className="replace" onClick={() => fileInputs.current[slot]?.click()}>Replace</button></div>
                : deviceSlot.status === "invalid" ? <button className="drop-zone invalid-slot" onClick={() => fileInputs.current[slot]?.click()}><span>!</span><strong>Invalid capture</strong><small>choose a replacement</small></button>
                  : <button className="drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, slot)} onClick={() => fileInputs.current[slot]?.click()}><span>＋</span><strong>Drop a NAM here</strong><small>or choose a file</small></button>}
            <input ref={(el) => { fileInputs.current[slot] = el; }} onChange={(e: ChangeEvent<HTMLInputElement>) => choose(slot, e.target.files)} type="file" accept=".nam,.namb" hidden />
            <p className="slot-foot">{file ? "Ready to send" : deviceSlot.status === "installed" ? `Stored in pedal · CRC ${deviceSlot.crc.toUpperCase()}` : "Accepts .nam or .namb"}</p>
          </article>;
        })}
      </div>
      <p className="hint"><b>Compatibility is checked when you connect.</b> A1 uses Nano-ReLU / NAMB; A2-Lite uses compatible A2 `.nam` captures.</p>
    </section>
    <section className="reverb-section">
      <div className="section-heading"><div><p className="eyebrow">02 / Toggle 1</p><h2>Reverb assignment</h2></div><p>Center is bypass. UP and DOWN must use different engines.</p></div>
      <div className="toggle-map"><div className="position-label up-label">UP <span>Toggle 1</span></div><div className="toggle-visual"><div className="switch-cap" /><div className="switch-line" /><div className="switch-base"><b>UP</b><b>OFF</b><b>DOWN</b></div></div><div className="position-label down-label">DOWN <span>Toggle 1</span></div></div>
      <div className="reverb-grid">
        {reverbs.map((reverb) => <article className={`reverb-card ${up === reverb.id || down === reverb.id ? "chosen" : ""}`} key={reverb.id}><span className="reverb-glyph">{reverb.glyph}</span><div><h3>{reverb.name}</h3><p>{reverb.description}</p></div><div className="assignments"><button className={up === reverb.id ? "active" : ""} onClick={() => selectReverb("up", reverb.id)}>UP</button><button className={down === reverb.id ? "active" : ""} onClick={() => selectReverb("down", reverb.id)}>DOWN</button></div></article>)}
      </div>
    </section>
    <footer className="actionbar"><div><span className="status-dot" /><b>{notice}</b><small>Chrome / Edge required for direct USB transfer.</small></div><button className="apply" onClick={sendConfiguration} disabled={busy}>{backend ? "Send to pedal" : "Connect & send"} <span>→</span></button></footer>
  </main>;
}

"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";
import {
  backendFromInfo,
  parseDeviceSlot,
  prepareCapture,
  uploadCapture,
  type Backend,
  type PreparedCapture,
} from "./capture-tools";

type Slot = "A" | "B" | "C";
type StagedSlotState = Record<Slot, File | null>;
type ValidationState = Record<Slot, boolean>;
type DeviceCapture = { status: "installed"; name: string; size: number; format: string; crc: string };
type DeviceSlot = DeviceCapture | { status: "empty" | "invalid" };
type DeviceSlotState = Record<Slot, DeviceSlot>;
type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};
type SerialNavigator = Navigator & {
  serial?: { requestPort(): Promise<SerialPortLike> };
};

const reverbs = [
  { id: "hybrid", name: "Hybrid Space", description: "Articulate room", glyph: "✦" },
  { id: "dattorro", name: "Dattorro", description: "Dense modulated hall", glyph: "◌" },
  { id: "fdn16", name: "FDN-16", description: "Wide diffusion field", glyph: "≈" },
  { id: "reverbsc", name: "ReverbSC", description: "Classic spacious verb", glyph: "⌁" },
];

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const [stagedSlots, setStagedSlots] = useState<StagedSlotState>({ A: null, B: null, C: null });
  const [validatedSlots, setValidatedSlots] = useState<ValidationState>({ A: false, B: false, C: false });
  const [deviceSlots, setDeviceSlots] = useState<DeviceSlotState>({ A: { status: "empty" }, B: { status: "empty" }, C: { status: "empty" } });
  const [up, setUp] = useState("hybrid");
  const [down, setDown] = useState("dattorro");
  const [notice, setNotice] = useState("Ready to connect");
  const [backend, setBackend] = useState<Backend | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputs = useRef<Record<Slot, HTMLInputElement | null>>({ A: null, B: null, C: null });
  const portRef = useRef<SerialPortLike | null>(null);
  const installed = useMemo(() => (["A", "B", "C"] as Slot[]).filter((slot) => stagedSlots[slot] || deviceSlots[slot].status === "installed").length, [deviceSlots, stagedSlots]);

  const choose = async (slot: Slot, files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.nam$/i.test(file.name)) {
      setNotice("Choose a Tone3000 .nam download containing an A2-Lite model");
      return;
    }
    try {
      if (backend) {
        setNotice(`Checking ${file.name}…`);
        prepareCapture(backend, file.name, new Uint8Array(await file.arrayBuffer()));
      }
      setStagedSlots((current) => ({ ...current, [slot]: file }));
      setValidatedSlots((current) => ({ ...current, [slot]: Boolean(backend) }));
      setNotice(backend
        ? `${file.name} is compatible and ready for slot ${slot}`
        : `${file.name} selected · connect the pedal to check compatibility`);
    } catch (error) {
      setStagedSlots((current) => ({ ...current, [slot]: null }));
      setValidatedSlots((current) => ({ ...current, [slot]: false }));
      setNotice(error instanceof Error ? error.message : "Capture is not compatible with this pedal");
    }
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
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) { setNotice("Use Chrome or Edge on desktop for direct USB connection"); return; }
    try {
      setBusy(true);
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      const info = await request("HNAM INFO", 4000);
      const detectedBackend = backendFromInfo(info);
      const nextSlots = {} as DeviceSlotState;
      for (const slot of ["A", "B", "C"] as Slot[]) {
        const detail = await request(`HNAM SLOT ${slot}`, 4000);
        nextSlots[slot] = parseDeviceSlot(slot, detail);
      }
      const reverb = await request("HNAM REVERB INFO", 4000);
      const connectedUp = reverb.find((value) => value.startsWith("up="))?.slice(3);
      const connectedDown = reverb.find((value) => value.startsWith("down="))?.slice(5);
      if (connectedUp && connectedDown) { setUp(connectedUp); setDown(connectedDown); }
      setDeviceSlots(nextSlots);
      setBackend(detectedBackend);
      setValidatedSlots({ A: false, B: false, C: false });
      setNotice(`Connected · ${backendLabel(detectedBackend)}`);
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
      setNotice("Checking capture compatibility…");
      const prepared = new Map<Slot, PreparedCapture>();
      for (const slot of ["A", "B", "C"] as Slot[]) {
        const file = stagedSlots[slot];
        if (!file) continue;
        prepared.set(slot, prepareCapture(backend, file.name, new Uint8Array(await file.arrayBuffer())));
        setValidatedSlots((current) => ({ ...current, [slot]: true }));
      }
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
      for (const slot of ["A", "B", "C"] as Slot[]) {
        const file = stagedSlots[slot];
        const capture = prepared.get(slot);
        if (!file || !capture) continue;
        const checksum = await uploadCapture(request, slot, capture,
          (percent) => setNotice(`Sending ${file.name} · ${percent}%`));
        setDeviceSlots((currentSlots) => ({ ...currentSlots, [slot]: {
          status: "installed", name: capture.name, size: capture.payload.length,
          format: capture.format, crc: checksum,
        } }));
        setStagedSlots((currentSlots) => ({ ...currentSlots, [slot]: null }));
        setValidatedSlots((currentSlots) => ({ ...currentSlots, [slot]: false }));
      }
      setNotice("Configuration sent to pedal");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not send configuration"); }
    finally { setBusy(false); }
  };
  const deleteSlot = async (slot: Slot) => {
    if (!backend) { setNotice("Connect the pedal before clearing a slot"); return; }
    if (!window.confirm(`Clear capture slot ${slot} on the pedal?`)) return;
    try {
      setBusy(true);
      const response = await request(`HNAM DELETE ${slot}`, 20000);
      if (response[0] !== "DELETE" || response[1] !== slot) throw new Error("Pedal did not confirm the slot was cleared");
      setDeviceSlots((current) => ({ ...current, [slot]: { status: "empty" } }));
      setNotice(`Capture slot ${slot} cleared`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not clear the slot"); }
    finally { setBusy(false); }
  };

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Hothouse NAM editor home"><span className="brand-mark">H</span> Hothouse <b>NAM</b></a>
      <div className="connection"><span className="status-dot" /> {backend ? "Connected · A2-Lite" : "Pedal not connected"} <button onClick={connectPedal} disabled={busy}>{busy ? "Working…" : backend ? "Reconnect" : "Connect pedal"}</button></div>
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
            {file ? <div className="file-loaded"><span className="file-icon">▤</span><div><strong>{file.name.replace(/\.nam$/i, "")}</strong><small>STAGED · NAM · {size(file.size)}</small></div><button className="remove" onClick={() => { setStagedSlots((current) => ({ ...current, [slot]: null })); setValidatedSlots((current) => ({ ...current, [slot]: false })); setNotice(`Slot ${slot} staging cleared`); }} aria-label={`Undo replacement for slot ${slot}`}>×</button></div>
              : deviceSlot.status === "installed" ? <div className="file-loaded"><span className="file-icon">▤</span><div><strong>{deviceSlot.name}</strong><small>ON PEDAL · A2-LITE · {size(deviceSlot.size)}</small></div><div className="slot-actions"><button className="replace" onClick={() => fileInputs.current[slot]?.click()}>Replace</button><button className="clear-slot" onClick={() => deleteSlot(slot)}>Clear</button></div></div>
                : deviceSlot.status === "invalid" ? <div className="invalid-capture"><button className="drop-zone invalid-slot" onClick={() => fileInputs.current[slot]?.click()}><span>!</span><strong>Unreadable slot data</strong><small>choose a compatible replacement</small></button><button className="clear-slot clear-invalid" onClick={() => deleteSlot(slot)} aria-label={`Clear unreadable data from slot ${slot}`}>Clear slot</button></div>
                  : <button className="drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, slot)} onClick={() => fileInputs.current[slot]?.click()}><span>＋</span><strong>Drop a NAM here</strong><small>or choose a file</small></button>}
            <input ref={(el) => { fileInputs.current[slot] = el; }} onChange={(e: ChangeEvent<HTMLInputElement>) => choose(slot, e.target.files)} type="file" accept=".nam" hidden />
            <p className="slot-foot">{file ? validatedSlots[slot] ? "Compatible · Ready to send" : "Connect to check compatibility" : deviceSlot.status === "installed" ? `Stored in pedal · CRC ${deviceSlot.crc.toUpperCase()}` : deviceSlot.status === "invalid" ? "Stored data failed validation" : "Accepts Tone3000 .nam downloads"}</p>
          </article>;
        })}
      </div>
      <p className="hint"><b>Compatibility is checked before anything is sent.</b> The editor searches every model in a Tone3000 .nam download and selects a device-compatible A2-Lite model.</p>
    </section>
    <section className="reverb-section">
      <div className="section-heading"><div><p className="eyebrow">02 / Toggle 1</p><h2>Reverb assignment</h2></div><p>Center is bypass. UP and DOWN must use different engines.</p></div>
      <div className="toggle-map"><div className="position-label up-label">UP <span>Toggle 1</span></div><div className="toggle-visual"><div className="switch-cap" /><div className="switch-line" /><div className="switch-base"><b>UP</b><b>OFF</b><b>DOWN</b></div></div><div className="position-label down-label">DOWN <span>Toggle 1</span></div></div>
      <div className="reverb-grid">
        {reverbs.map((reverb) => <article className={`reverb-card ${up === reverb.id || down === reverb.id ? "chosen" : ""}`} key={reverb.id}><span className="reverb-glyph">{reverb.glyph}</span><div><h3>{reverb.name}</h3><p>{reverb.description}</p></div><div className="assignments"><button className={up === reverb.id ? "active" : ""} onClick={() => selectReverb("up", reverb.id)}>UP</button><button className={down === reverb.id ? "active" : ""} onClick={() => selectReverb("down", reverb.id)}>DOWN</button></div></article>)}
      </div>
    </section>
    <footer className="actionbar"><div><span className="status-dot" /><b>{notice}</b><small>Chrome / Edge required for direct USB transfer.</small></div><button className="apply" onClick={sendConfiguration} disabled={busy}>{backend ? "Send to pedal" : "Connect pedal"} <span>→</span></button></footer>
  </main>;
}

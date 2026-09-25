"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";

type Slot = "A" | "B" | "C";
type SlotState = Record<Slot, File | null>;

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
  const [slots, setSlots] = useState<SlotState>({ A: null, B: null, C: null });
  const [up, setUp] = useState("hybrid");
  const [down, setDown] = useState("dattorro");
  const [notice, setNotice] = useState("Ready to connect");
  const fileInputs = useRef<Record<Slot, HTMLInputElement | null>>({ A: null, B: null, C: null });
  const installed = useMemo(() => Object.values(slots).filter(Boolean).length, [slots]);

  const choose = (slot: Slot, files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(nam|namb)$/i.test(file.name)) {
      setNotice("Choose a .nam or .namb capture file");
      return;
    }
    setSlots((current) => ({ ...current, [slot]: file }));
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
  const apply = () => {
    const loaded = (["A", "B", "C"] as Slot[]).filter((slot) => slots[slot]).join(", ");
    setNotice(loaded ? `Configuration ready — slots ${loaded}; toggle mapping saved locally` : "Reverb mapping saved locally — add captures when ready");
  };

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Hothouse NAM editor home"><span className="brand-mark">H</span> Hothouse <b>NAM</b></a>
      <div className="connection"><span className="status-dot" /> Pedal not connected <button onClick={() => setNotice("Connect a powered Hothouse NAM pedal to enable sending")}>Connect pedal</button></div>
    </header>
    <section className="hero" id="top">
      <p className="eyebrow">Configuration editor</p>
      <h1>Shape your <em>three voices.</em></h1>
      <p className="lede">Stage amp captures for each panel position, then choose the two reverbs that live on Toggle 1.</p>
      <div className="progress"><span>{installed} of 3 captures staged</span><div><i style={{ width: `${installed * 33.33}%` }} /></div><span>toggle mapping set</span></div>
    </section>
    <section className="workspace" aria-label="Pedal configuration">
      <div className="section-heading"><div><p className="eyebrow">01 / Capture bank</p><h2>Load NAM captures</h2></div><p>Each slot follows the panel’s A / B / C selector.</p></div>
      <div className="slot-grid">
        {(["A", "B", "C"] as Slot[]).map((slot, index) => {
          const file = slots[slot];
          return <article className={`slot-card ${file ? "has-file" : ""}`} key={slot}>
            <div className="slot-top"><span className="slot-letter">{slot}</span><span className="slot-position">{["UP", "CENTER", "DOWN"][index]}</span></div>
            {file ? <div className="file-loaded"><span className="file-icon">▤</span><div><strong>{file.name.replace(/\.(nam|namb)$/i, "")}</strong><small>{file.name.split(".").pop()?.toUpperCase()} · {size(file.size)}</small></div><button className="remove" onClick={() => { setSlots((current) => ({ ...current, [slot]: null })); setNotice(`Slot ${slot} cleared`); }} aria-label={`Clear slot ${slot}`}>×</button></div> : <button className="drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, slot)} onClick={() => fileInputs.current[slot]?.click()}><span>＋</span><strong>Drop a NAM here</strong><small>or choose a file</small></button>}
            <input ref={(el) => { fileInputs.current[slot] = el; }} onChange={(e: ChangeEvent<HTMLInputElement>) => choose(slot, e.target.files)} type="file" accept=".nam,.namb" hidden />
            <p className="slot-foot">{file ? "Ready to send" : "Accepts .nam or .namb"}</p>
          </article>;
        })}
      </div>
      <p className="hint"><b>Compatibility is checked when you connect.</b> A1 expects Nano-ReLU / NAMB; A2-Lite expects compatible A2 `.nam` captures.</p>
    </section>
    <section className="reverb-section">
      <div className="section-heading"><div><p className="eyebrow">02 / Toggle 1</p><h2>Assign your reverbs</h2></div><p>Middle is always bypass. Pick two different engines for the outer positions.</p></div>
      <div className="toggle-map"><div className="position-label up-label">UP <span>Toggle 1</span></div><div className="toggle-visual"><div className="switch-cap" /><div className="switch-line" /><div className="switch-base"><b>UP</b><b>OFF</b><b>DOWN</b></div></div><div className="position-label down-label">DOWN <span>Toggle 1</span></div></div>
      <div className="reverb-grid">
        {reverbs.map((reverb) => <article className={`reverb-card ${up === reverb.id || down === reverb.id ? "chosen" : ""}`} key={reverb.id}><span className="reverb-glyph">{reverb.glyph}</span><div><h3>{reverb.name}</h3><p>{reverb.description}</p></div><div className="assignments"><button className={up === reverb.id ? "active" : ""} onClick={() => selectReverb("up", reverb.id)}>UP</button><button className={down === reverb.id ? "active" : ""} onClick={() => selectReverb("down", reverb.id)}>DOWN</button></div></article>)}
      </div>
    </section>
    <footer className="actionbar"><div><span className="status-dot" /><b>{notice}</b><small>Changes are only sent after the pedal is connected.</small></div><button className="apply" onClick={apply}>Save configuration <span>→</span></button></footer>
  </main>;
}

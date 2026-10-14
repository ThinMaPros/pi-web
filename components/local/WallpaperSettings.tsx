"use client";

// local: Settings > General section for the wallpaper (pick file, tuning, remove).

import { useEffect, useRef, useState } from "react";
import { ConfigButton } from "../SettingsUi";
import {
  DEFAULT_TUNING,
  TUNING_RANGES,
  WALLPAPER_CHANGED_EVENT,
  clearWallpaper,
  loadTuning,
  loadWallpaper,
  saveTuning,
  saveWallpaper,
  type WallpaperTuning,
} from "@/lib/local/wallpaper-store";

const SLIDERS: { key: keyof WallpaperTuning; label: string; hint: string }[] = [
  { key: "surface", label: "Surface opacity", hint: "Độ đục lớp nền dưới toàn app. Thấp: ảnh rõ hơn. Cao: chữ dễ đọc hơn." },
  { key: "panel", label: "Sidebar & panels tint", hint: "Lớp phủ thêm cho sidebar, thanh trên, minimap. 0%: trong như khung chat." },
  { key: "brightness", label: "Image brightness", hint: "Độ sáng của ảnh. Giảm để ảnh tối đi, chữ nổi hơn." },
  { key: "saturation", label: "Image saturation", hint: "Độ rực màu của ảnh. 0%: đen trắng, trên 100%: màu đậm hơn." },
];

export function WallpaperSettings() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasImage, setHasImage] = useState(false);
  const [tuning, setTuning] = useState<WallpaperTuning>(DEFAULT_TUNING);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTuning(loadTuning());
    const syncImage = () => void loadWallpaper().then((blob) => setHasImage(!!blob)).catch(() => setHasImage(false));
    syncImage();
    window.addEventListener(WALLPAPER_CHANGED_EVENT, syncImage);
    return () => window.removeEventListener(WALLPAPER_CHANGED_EVENT, syncImage);
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (next: WallpaperTuning) => {
    setTuning(next);
    saveTuning(next);
  };
  const isDefault = SLIDERS.every(({ key }) => tuning[key] === DEFAULT_TUNING[key]);

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">Wallpaper</h3>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{busy ? "Saving…" : hasImage ? "Image set" : "No image"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            {hasImage && (
              <ConfigButton variant="ghost" size="small" disabled={isDefault} onClick={() => update(DEFAULT_TUNING)}>
                Reset
              </ConfigButton>
            )}
            {hasImage && (
              <ConfigButton variant="ghost" size="small" disabled={busy} onClick={() => void run(clearWallpaper)}>
                Remove
              </ConfigButton>
            )}
            <ConfigButton size="small" disabled={busy} onClick={() => inputRef.current?.click()}>
              {hasImage ? "Change image" : "Choose image"}
            </ConfigButton>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void run(() => saveWallpaper(file));
            }}
          />
        </div>
        {hasImage && SLIDERS.map(({ key, label, hint }) => {
          const range = TUNING_RANGES[key];
          const id = `settings-wallpaper-${key}`;
          return (
            <div key={key} className="settings-chat-option settings-chat-range-option" title={hint}>
              <div className="settings-chat-range-header">
                <label htmlFor={id}>{label}</label>
                <output htmlFor={id}>{tuning[key]}%</output>
              </div>
              <input
                id={id}
                type="range"
                min={range.min}
                max={range.max}
                step={range.step}
                value={tuning[key]}
                onChange={(event) => update({ ...tuning, [key]: Number(event.target.value) })}
              />
            </div>
          );
        })}
        {error && <div style={{ color: "#ef4444", fontSize: 12 }}>{error}</div>}
      </div>
    </section>
  );
}

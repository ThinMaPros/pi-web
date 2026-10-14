"use client";

// local: renders the stored wallpaper as one fixed layer behind the whole app
// and switches the theme surfaces to translucent (see app/local-wallpaper.css).

import { useEffect, useState } from "react";
import {
  WALLPAPER_CHANGED_EVENT,
  WALLPAPER_TUNING_EVENT,
  applyTuning,
  loadTuning,
  loadWallpaper,
} from "@/lib/local/wallpaper-store";

export function Wallpaper() {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let current: string | null = null;
    let cancelled = false;

    const refreshImage = async () => {
      const blob = await loadWallpaper().catch(() => null);
      if (cancelled) return;
      const next = blob ? URL.createObjectURL(blob) : null;
      if (current) URL.revokeObjectURL(current);
      current = next;
      setUrl(next);
      if (next) document.documentElement.setAttribute("data-wallpaper", "");
      else document.documentElement.removeAttribute("data-wallpaper");
    };
    const refreshTuning = () => applyTuning(loadTuning());

    refreshTuning();
    void refreshImage();
    window.addEventListener(WALLPAPER_CHANGED_EVENT, refreshImage);
    window.addEventListener(WALLPAPER_TUNING_EVENT, refreshTuning);
    return () => {
      cancelled = true;
      window.removeEventListener(WALLPAPER_CHANGED_EVENT, refreshImage);
      window.removeEventListener(WALLPAPER_TUNING_EVENT, refreshTuning);
      if (current) URL.revokeObjectURL(current);
    };
  }, []);

  if (!url) return null;
  return <div className="local-wallpaper" style={{ backgroundImage: `url("${url}")` }} aria-hidden="true" />;
}

import { createServerFn } from "@tanstack/react-start";
import { resolveClipUrl } from "./resolve.server";
import type { ClipMedia } from "./types";

export const resolveClip = createServerFn({ method: "POST" })
  .validator((data: unknown): { url: string; fresh?: boolean } => {
    if (!data || typeof data !== "object" || typeof (data as { url?: unknown }).url !== "string") {
      throw new Error("Paste a TikTok, Instagram, or X link.");
    }
    const url = (data as { url: string }).url.trim();
    if (!url || url.length > 4000) throw new Error("That link is too long to read.");
    return { url, fresh: (data as { fresh?: unknown }).fresh === true };
  })
  .handler(async ({ data }): Promise<ClipMedia> => resolveClipUrl(data.url, { fresh: data.fresh === true }));

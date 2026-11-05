import type { ClipMedia, Variant } from "@/lib/clip/types";

/** Video variants that are the same clip at different qualities share a group. */
export function videoGroups(media: ClipMedia): Variant[][] {
  const groups = new Map<string, Variant[]>();
  for (const variant of media.variants.filter((item) => item.kind === "video")) {
    const key = variant.group || variant.id;
    const list = groups.get(key);
    if (list) list.push(variant);
    else groups.set(key, [variant]);
  }
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0)),
  );
}

/**
 * Every file in the post, for "Save all": each photo, the best quality of each
 * video (so a Live Photo's motion video is included but a clip saved at three
 * qualities isn't saved three times), and any audio tracks.
 */
export function allTargetsOf(media: ClipMedia): Variant[] {
  const photos = media.variants.filter((variant) => variant.kind === "image");
  const videos = videoGroups(media).map((group) => group[0]);
  const audios = media.variants.filter((variant) => variant.kind === "audio");
  return [...photos, ...videos, ...audios];
}

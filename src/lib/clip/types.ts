export type Platform = "tiktok" | "instagram" | "x";
export type MediaKind = "image" | "video" | "audio";

export type Variant = {
  id: string;
  kind: MediaKind;
  label: string;
  url: string;
  ext: string;
  width?: number;
  height?: number;
  bitrate?: number;
  index?: number;
  group?: string;
  noWatermark?: boolean;
};

export type ClipMedia = {
  platform: Platform;
  sourceUrl: string;
  title: string;
  author: string;
  authorHandle?: string;
  thumbnail?: string;
  duration?: number;
  notice?: string;
  variants: Variant[];
};

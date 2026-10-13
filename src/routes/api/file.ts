import { createFileRoute } from "@tanstack/react-router";
import { proxyMedia } from "@/lib/clip/files";

export const Route = createFileRoute("/api/file")({
  server: {
    handlers: {
      GET: async ({ request }) => proxyMedia(request),
    },
  },
});

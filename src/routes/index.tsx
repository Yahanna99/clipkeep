import { createFileRoute } from "@tanstack/react-router";
import { Clipkeep } from "@/components/clipkeep";

export const Route = createFileRoute("/")({
  component: Clipkeep,
});

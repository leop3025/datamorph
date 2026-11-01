import type { Metadata } from "next";
import { StudioLoader } from "@/components/studio/StudioLoader";

export const metadata: Metadata = { title: "Studio · Datamorph" };

export default function StudioPage() {
  return <StudioLoader />;
}

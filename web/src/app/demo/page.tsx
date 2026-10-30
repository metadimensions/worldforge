import type { Metadata } from "next";

import ReplayViewer from "@/components/ReplayViewer";

export const metadata: Metadata = {
  title: "WorldForge · Live demo",
  description: "3D replay of WorldForge warehouse robot simulations, with AI-guided failure testing.",
};

export default function DemoPage() {
  return <ReplayViewer />;
}

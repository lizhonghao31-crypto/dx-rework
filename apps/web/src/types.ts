import type { Tone } from "@dx-rework/ui";

export type Task = { id: string; title: string; meta: string; tone: Extract<Tone, "info" | "warning" | "danger"> };

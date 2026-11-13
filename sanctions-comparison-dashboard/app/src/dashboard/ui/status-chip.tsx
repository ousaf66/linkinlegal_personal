import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const CHIP_TONES = {
  green: {
    pill: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400",
    dot: "bg-green-500",
  },
  amber: {
    pill: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  orange: {
    pill: "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  red: {
    pill: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
    dot: "bg-red-500",
  },
  neutral: { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};

export function StatusChip({
  tone,
  children,
}: {
  tone: keyof typeof CHIP_TONES;
  children: ReactNode;
}) {
  return (
    <Badge
      variant="secondary"
      className={cn("gap-1.5 rounded-sm capitalize", CHIP_TONES[tone].pill)}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", CHIP_TONES[tone].dot)} />
      {children}
    </Badge>
  );
}

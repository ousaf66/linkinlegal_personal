import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "./index.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ScraperInternalPage } from "@/dashboard/scraper-internal-page";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ScraperInternalPage />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

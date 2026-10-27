import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import App from "./App";
import { AutoRefreshProvider } from "./hooks/useAutoRefresh";
import { wagmiConfig } from "./config/wagmi";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AutoRefreshProvider>
          <App />
        </AutoRefreshProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);

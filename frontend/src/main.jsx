import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SolanaWalletProvider from "./WalletProvider";
import App from "./App";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <SolanaWalletProvider>
      <App />
    </SolanaWalletProvider>
  </StrictMode>
);
import { useMemo } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddr } from "../lib/format";

export function WalletButton() {
  const { address, connector, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  const options = useMemo(() => {
    // EIP-6963 announced wallets have their rdns as id; hide the generic fallback when any is present.
    const announced = connectors.filter((c) => c.id !== "injected");
    const list = announced.length > 0 ? announced : connectors;
    // A wallet can announce more than once (Fordefi does, partly via its MetaMask emulation).
    // Keep the first connector per display name so the user sees one button per wallet.
    const seen = new Set<string>();
    const unique = list.filter((c) => {
      const key = c.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.sort((a, b) => Number(/fordefi/i.test(b.name)) - Number(/fordefi/i.test(a.name)));
  }, [connectors]);

  if (isConnected && address) {
    return (
      <div className="wallet">
        <span className="pill">
          {connector?.name ?? "Wallet"} · <span className="mono">{shortAddr(address)}</span>
        </span>
        <button className="ghost" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    );
  }

  const hasFordefi = options.some((c) => /fordefi/i.test(c.name));

  return (
    <div className="wallet">
      {options.map((c) => (
        <button key={c.uid} className="primary" disabled={isPending} onClick={() => connect({ connector: c })}>
          {c.icon ? <img src={c.icon} alt="" width={16} height={16} /> : null}
          Connect {c.name}
        </button>
      ))}
      {!hasFordefi && (
        <span className="hint">
          Fordefi not detected. Unlock the Fordefi extension, or enable MetaMask emulation in its settings and reload.
        </span>
      )}
      {error && <span className="error">{error.message}</span>}
    </div>
  );
}

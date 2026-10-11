import { useEffect, useState } from "react";

/** Mounted for one outgoing message. Quick acknowledgements need no extra row. */
export function OutgoingDeliveryStatus({ status, scope }: { readonly scope: object; readonly status: "sending" | "sent" | "unconfirmed" }) {
  const [delayed, setDelayed] = useState<object | null>(null);
  useEffect(() => {
    if (status !== "sending") return;
    const timer = setTimeout(() => setDelayed(scope), 2000);
    return () => clearTimeout(timer);
  }, [scope, status]);
  if (delayed !== scope && status !== "unconfirmed") return null;
  return <p role="status">{status === "sending" ? "Sending…" : status === "sent" ? "Sent" : "Send unconfirmed — retry saved message"}</p>;
}

import "./received-quantity-label.css";

/** Only for receipt quantities that include defective pieces, never good-piece counts. */
export function ReceivedQuantityLabel({ children }: { children: string }) {
  return <span className="received-quantity-label"><span>{children}</span><small className="received-quantity-note">含次品数</small></span>;
}

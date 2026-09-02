import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { dateTime } from "../lib/format.js";
import { errorMessage, useApp } from "../lib/store.js";
import type { AuditEntry } from "../lib/types.js";
import { Spinner } from "../ui/primitives.js";

export function AuditAdmin() {
  const toast = useApp((s) => s.toast);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.admin
      .audit(200)
      .then((r) => setEntries(r.entries))
      .catch((e) => toast(errorMessage(e), "danger"));
  }, [toast]);
  return (
    <div className="stack lg">
      <div>
        <h1>Audit log</h1>
        <p className="muted small">Who changed what. Sign-ins, role changes, provider keys, plugin settings.</p>
      </div>
      {!entries ? (
        <Spinner label="Loading" />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="small muted" style={{ whiteSpace: "nowrap" }}>
                    {dateTime(e.createdAt)}
                  </td>
                  <td className="small">{e.actorEmail ?? "system"}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="tiny muted mono" style={{ maxWidth: 420, overflowWrap: "anywhere" }}>
                    {e.target ? `${e.target} ` : ""}
                    {e.details ? JSON.stringify(e.details) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

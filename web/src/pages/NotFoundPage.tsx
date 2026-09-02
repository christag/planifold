import { Link } from "react-router-dom";
import { Shell } from "../ui/Shell.js";

export function NotFoundPage() {
  return (
    <Shell>
      <div className="card">
        <div className="empty">
          <h3>There's nothing at this address</h3>
          <p className="small">
            <Link to="/">Back to your plans</Link>
          </p>
        </div>
      </div>
    </Shell>
  );
}

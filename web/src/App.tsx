import type { WorkspaceHome } from "./workspace";
import { buildWorkspaceHome } from "./workspace";
import "./styles.css";

const HIVE_MARK = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 7L16.33 9.5V14.5L12 17L7.67 14.5V9.5L12 7Z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function WorkspaceHomeView({ model }: { model: WorkspaceHome }) {
  return (
    <div className="page" data-testid="workspace-home">
      <p className="kicker">Hyper Intelligence for Verified Engineering</p>
      <h1>Workspace</h1>
      <p className="lede">
        Personal workspace for the HIVE control plane. HiveChat, Hive Code, and verified runs stay on your machine.
        Sign-in, billing, the usage ledger, and cloud execution are not connected.
      </p>

      <div className="split">
        <section className="pane" aria-labelledby="account-heading">
          <h2 id="account-heading">Account</h2>
          <dl className="meta">
            <dt>Identity</dt>
            <dd>{model.account.label}</dd>
            <dt>Session</dt>
            <dd>Not connected</dd>
            <dt>Workspace</dt>
            <dd>{model.workspace.name}</dd>
            <dt>Tenant</dt>
            <dd className="mono">{model.workspace.id}</dd>
            <dt>Role</dt>
            <dd>{model.workspace.role}</dd>
            <dt>Membership</dt>
            <dd>{model.workspace.status}</dd>
          </dl>
          <div className="sign-in">
            <button type="button" disabled aria-describedby="sign-in-status">
              Sign in
            </button>
            <p id="sign-in-status">Not connected. No credentials are stored here.</p>
          </div>
        </section>

        <section className="pane" aria-labelledby="plan-heading">
          <h2 id="plan-heading">Plan</h2>
          <dl className="meta">
            <dt>Shown plan</dt>
            <dd>{model.plan.label}</dd>
            <dt>Plan id</dt>
            <dd className="mono">{model.plan.id}</dd>
            <dt>Authority</dt>
            <dd>Local preview</dd>
          </dl>
          <p className="note">
            Pro, Power, Team, and Enterprise are names for future packaging. This screen does not grant access.
          </p>
          <ul className="plan-list">
            {model.hostedPlans.map((plan) => (
              <li key={plan.id}>
                <span>{plan.label}</span>
                <span className="tag">Designed only</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="pane section" aria-labelledby="entitlements-heading">
        <h2 id="entitlements-heading">Entitlements</h2>
        <p className="note">
          Commercial entitlements from the control-plane contract. Community includes none of them. Enforcement is not connected.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Identifier</th>
                <th scope="col">Community</th>
                <th scope="col">Designed for</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {model.entitlements.map((row) => (
                <tr key={row.id} data-testid={`entitlement-${row.id}`}>
                  <td>{row.label}</td>
                  <td className="mono">{row.id}</td>
                  <td>No</td>
                  <td>{row.designedFor}</td>
                  <td>Not connected</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pane section" aria-labelledby="boundaries-heading">
        <h2 id="boundaries-heading">Hosted boundaries</h2>
        <ul className="boundaries">
          {model.boundaries.map((boundary) => (
            <li key={boundary.id} data-testid={`boundary-${boundary.id}`}>
              <h3>{boundary.label}</h3>
              <p className="state">Not connected</p>
              <p>{boundary.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="pane section runtime" aria-labelledby="runtime-heading">
        <h2 id="runtime-heading" className="runtime-heading">Local runtime</h2>
        <div className="runtime-grid">
          <article>
            <h3>HiveChat</h3>
            <p>{model.localRuntime.hiveChat}</p>
          </article>
          <article>
            <h3>Hive Code</h3>
            <p>{model.localRuntime.hiveCode}</p>
          </article>
          <article>
            <h3>Verified runs</h3>
            <p>{model.localRuntime.verifiedRuns}</p>
            <p>{model.localRuntime.byok}</p>
            <p>
              Remote push waits for <code>{model.localRuntime.pushCommand}</code>.
            </p>
          </article>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const model = buildWorkspaceHome();
  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          {HIVE_MARK}
          <span className="wordmark">HIVE</span>
          <span className="product-name">Control plane</span>
        </div>
        <p className="status-pill">not connected</p>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Control plane">
          <p className="nav-label">Surfaces</p>
          <a href="#workspace" aria-current="page">
            Workspace
          </a>
          <div className="sidebar-foot">
            <p>BYOK on the local runtime</p>
            <p>Remote push waits for confirmation</p>
            <p>Community stays available offline</p>
          </div>
        </nav>
        <main id="workspace">
          <WorkspaceHomeView model={model} />
        </main>
      </div>
    </div>
  );
}

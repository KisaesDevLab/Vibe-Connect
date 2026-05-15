import { AdminClients } from './Admin.js';

// Top-level Clients section for any authenticated staff. The underlying
// component already gates its admin-only controls (Add client, Deactivate,
// Reactivate, Forget, Reinvite) on useAuth().user.isAdmin, so the same
// component renders the read-only variant for non-admins and the full
// admin variant for admins — no further branching needed at this layer.
//
// The legacy /admin/clients tab still mounts the same component for admins
// who navigate there directly; this page is the staff-accessible entry
// point reached from the top nav.
export function ClientsPage(): JSX.Element {
  return <AdminClients />;
}

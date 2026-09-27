import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Toaster } from "./components/ui/sonner.js";

const NAV_ITEMS = [
  { segment: "", label: "Overview" },
  { segment: "leads", label: "Leads" },
  { segment: "agents", label: "Agents" },
  { segment: "payouts", label: "Payouts" },
  { segment: "earnings", label: "Earnings" },
  { segment: "disputes", label: "Disputes" },
  { segment: "settings", label: "Settings" },
] as const;

function CampNav({ basePath, activeSegment }: { basePath: string; activeSegment: string }) {
  return (
    <nav className="flex items-center gap-1 border-b px-6 py-3 lg:px-10">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.segment}
          href={item.segment ? `${basePath}/${item.segment}` : basePath}
          className={
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
            (item.segment === activeSegment ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")
          }
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Camp's one mounted entry point, the way `@payloadcms/next`'s RootPage
 * works: the host wires a single catch-all route to this component and
 * everything under it (Overview, Leads, Payouts -- more as they migrate)
 * routes by the segments array Next.js hands a `[[...segments]]` page,
 * not by separate files per screen. `basePath` must be the exact path the
 * host mounted this catch-all at (e.g. "/admin"), since Camp has no way to
 * know its own mount point otherwise -- used to build this view's own nav
 * links and pagination links correctly regardless of where a host chooses
 * to mount it.
 *
 * Seven sections exist today (Overview, Leads, Agents, Payouts, Earnings,
 * Disputes, Settings) -- see packages/camp/README.md's migration status
 * for what's not here yet (currently just the Leads kanban board).
 * An unrecognized segment 404s rather than silently rendering nothing.
 *
 * Each view is imported dynamically inside its own switch branch, not
 * statically at the top of this file: a catch-all route is one page.tsx
 * handling every screen, so a static top-of-file import would bundle every
 * view's code for every request regardless of which one was actually
 * visited. This is the code-splitting the root README's "Where this is
 * going" section names as still outstanding for Camp as a whole -- applied
 * here at the one place (the shared router) it has to happen for any of
 * the rest to matter, even though only three views exist to split between
 * so far.
 */
export async function CampRootPage({
  params,
  searchParams,
  basePath,
}: {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  basePath: string;
}) {
  const { segments = [] } = await params;
  const search = await searchParams;
  const [section, ...rest] = segments;

  let view: ReactNode;
  switch (section) {
    case undefined: {
      const { OverviewView } = await import("./views/overview.js");
      view = <OverviewView basePath={basePath} />;
      break;
    }
    case "leads": {
      if (rest.length > 1) notFound();
      if (rest.length === 1) {
        const { LeadDetailView } = await import("./views/lead-detail.js");
        view = <LeadDetailView leadId={rest[0]} basePath={`${basePath}/leads`} />;
      } else {
        const rawPage = Array.isArray(search.page) ? search.page[0] : search.page;
        const parsedPage = Number(rawPage);
        const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
        const rawView = Array.isArray(search.view) ? search.view[0] : search.view;
        const leadsView = rawView === "kanban" ? "kanban" : "list";
        const { LeadsView } = await import("./views/leads.js");
        view = <LeadsView page={page} view={leadsView} basePath={`${basePath}/leads`} />;
      }
      break;
    }
    case "agents": {
      if (rest.length > 1) notFound();
      if (rest.length === 1) {
        const { AgentDetailView } = await import("./views/agent-detail.js");
        view = <AgentDetailView agentId={rest[0]} basePath={`${basePath}/agents`} />;
      } else {
        const { AgentsView } = await import("./views/agents.js");
        view = <AgentsView basePath={`${basePath}/agents`} />;
      }
      break;
    }
    case "payouts": {
      if (rest.length > 0) notFound();
      const { PayoutsView } = await import("./views/payouts.js");
      view = <PayoutsView />;
      break;
    }
    case "earnings": {
      if (rest.length > 0) notFound();
      const { EarningsView } = await import("./views/earnings.js");
      view = <EarningsView />;
      break;
    }
    case "settings": {
      if (rest.length > 1) notFound();
      const sub = rest[0] ?? "setup";
      if (sub === "setup") {
        const { SettingsSetupView } = await import("./views/settings-setup.js");
        view = <SettingsSetupView />;
      } else if (sub === "waypoint") {
        const { SettingsWaypointView } = await import("./views/settings-waypoint.js");
        view = <SettingsWaypointView />;
      } else {
        notFound();
      }
      break;
    }
    case "disputes": {
      if (rest.length > 1) notFound();
      if (rest.length === 1) {
        const { DisputeDetailView } = await import("./views/dispute-detail.js");
        view = <DisputeDetailView disputeId={rest[0]} basePath={`${basePath}/disputes`} />;
      } else {
        const { DisputesView } = await import("./views/disputes.js");
        view = <DisputesView basePath={`${basePath}/disputes`} />;
      }
      break;
    }
    default:
      notFound();
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <CampNav basePath={basePath} activeSegment={section ?? ""} />
      {view}
      <Toaster />
    </div>
  );
}

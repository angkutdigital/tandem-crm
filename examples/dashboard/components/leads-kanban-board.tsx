"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
} from "@/components/reui/kanban"
import { cn } from "cn"
import type { LeadSummary } from "@/lib/queries"
import { moveLeadStatus } from "@/lib/actions"

const PIPELINE_STATUSES = [
  "Automated_Setup",
  "Manual_Review",
  "Won",
  "Commission_Hold",
  "Commission_Eligible",
  "Commission_Paid",
  "Lost",
  "Refunded",
] as const

function humanizeStatus(status: string) {
  return status.replace(/_/g, " ")
}

function formatUpdatedDate(updatedAt: string) {
  return new Date(updatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function initialsOf(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

const statusVariantMap: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Automated_Setup: "outline",
  Manual_Review: "outline",
  Won: "secondary",
  Commission_Hold: "secondary",
  Commission_Eligible: "secondary",
  Commission_Paid: "default",
  Lost: "destructive",
  Refunded: "destructive",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariantMap[status] ?? "outline"}>
      {humanizeStatus(status)}
    </Badge>
  )
}

/** Groups the flat lead list into the eight pipeline columns, always
 * emitting every column (even empty ones) so the board keeps its shape. */
function groupLeads(leads: LeadSummary[]): Record<string, LeadSummary[]> {
  const columns: Record<string, LeadSummary[]> = {}
  for (const status of PIPELINE_STATUSES) columns[status] = []
  for (const lead of leads) {
    if (!columns[lead.pipelineStatus]) columns[lead.pipelineStatus] = []
    columns[lead.pipelineStatus].push(lead)
  }
  return columns
}

/** Finds which column an item id currently sits in, or undefined. */
function findColumn(
  columns: Record<string, LeadSummary[]>,
  leadId: string
): string | undefined {
  return Object.keys(columns).find((key) =>
    columns[key].some((lead) => lead.id === leadId)
  )
}

function LeadCard({ lead }: { lead: LeadSummary }) {
  return (
    <KanbanItem value={lead.id}>
      <KanbanItemHandle className="cursor-grab!">
        <div className="flex flex-col gap-2 rounded-md border bg-card p-3 transition-colors hover:bg-muted/60">
          <p className="truncate text-sm font-medium">{lead.companyName}</p>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Avatar className="size-5">
                <AvatarFallback className="text-[10px] font-medium">
                  {lead.assigneeName ? initialsOf(lead.assigneeName) : "?"}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-xs text-muted-foreground">
                {lead.assigneeName ?? "Unassigned"}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {formatUpdatedDate(lead.updatedAt)}
            </span>
          </div>
          <Link
            href={`/leads/${lead.id}`}
            className="text-xs font-medium text-muted-foreground underline-offset-3 hover:text-foreground hover:underline"
          >
            Open
          </Link>
        </div>
      </KanbanItemHandle>
    </KanbanItem>
  )
}

export function LeadsKanbanBoard({ leads }: { leads: LeadSummary[] }) {
  const router = useRouter()
  const [columns, setColumns] = useState<Record<string, LeadSummary[]>>(() =>
    groupLeads(leads)
  )

  function handleValueChange(next: Record<string, LeadSummary[]>) {
    const previous = columns

    // Find the single item that changed columns between the two states.
    let movedId: string | undefined
    let targetStatus: string | undefined
    for (const key of Object.keys(next)) {
      for (const lead of next[key]) {
        if (findColumn(previous, lead.id) !== key) {
          movedId = lead.id
          targetStatus = key
          break
        }
      }
      if (movedId) break
    }

    setColumns(next)

    if (!movedId || !targetStatus) return

    moveLeadStatus(movedId, targetStatus)
      .then(() => {
        router.refresh()
      })
      .catch((err: unknown) => {
        setColumns(previous)
        toast.error(err instanceof Error ? err.message : "Could not move lead")
      })
  }

  return (
    <Kanban
      value={columns}
      onValueChange={handleValueChange}
      getItemValue={(lead) => lead.id}
    >
      <KanbanBoard className="flex gap-4 overflow-x-auto pb-2">
        {PIPELINE_STATUSES.map((status) => (
          <KanbanColumn key={status} value={status} className="flex w-72 shrink-0 flex-col gap-3">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="text-sm font-medium">{humanizeStatus(status)}</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {columns[status]?.length ?? 0}
              </span>
            </div>
            <KanbanColumnContent
              value={status}
              className={cn(
                "flex min-h-24 flex-col gap-2 rounded-md border border-dashed p-2"
              )}
            >
              {(columns[status] ?? []).map((lead) => (
                <LeadCard key={lead.id} lead={lead} />
              ))}
            </KanbanColumnContent>
          </KanbanColumn>
        ))}
      </KanbanBoard>
    </Kanban>
  )
}

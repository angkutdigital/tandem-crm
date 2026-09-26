"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { assignAgentToTerritory } from "@/lib/actions"
import type { TerritorySummary } from "@/lib/queries"

export function AgentTerritoryManager({
  agentId,
  territories,
  assignedTerritoryIds,
  canManage,
}: {
  agentId: string
  territories: TerritorySummary[]
  assignedTerritoryIds: string[]
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const available = useMemo(
    () => territories.filter((territory) => territory.active && !assignedTerritoryIds.includes(territory.id)),
    [territories, assignedTerritoryIds]
  )
  const [selected, setSelected] = useState(available[0]?.id ?? "")

  function addCoverage() {
    if (!selected) return
    startTransition(async () => {
      try {
        await assignAgentToTerritory(agentId, selected)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add territory coverage")
      }
    })
  }

  if (!canManage || available.length === 0) return null

  return (
    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
      <select
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
        aria-label="Territory to cover"
      >
        {available.map((territory) => <option key={territory.id} value={territory.id}>{territory.name} · {territory.code}</option>)}
      </select>
      <Button type="button" size="sm" disabled={!selected || isPending} onClick={addCoverage}>
        {isPending ? "Adding..." : "Add coverage"}
      </Button>
    </div>
  )
}

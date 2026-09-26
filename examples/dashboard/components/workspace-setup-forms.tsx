"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createCommissionRule, createOnboardingStep, createTerritory, linkExistingUserToAgent } from "@/lib/actions"

export function AddOnboardingStepForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [code, setCode] = useState("")
  const [label, setLabel] = useState("")
  const [required, setRequired] = useState(true)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startTransition(async () => {
      try {
        await createOnboardingStep({ code, label, required })
        setCode("")
        setLabel("")
        setRequired(true)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add onboarding step")
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto_auto] sm:items-end">
      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-step-code">Step code</Label>
        <Input id="onboarding-step-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="product_training" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="onboarding-step-label">Label</Label>
        <Input id="onboarding-step-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Product training complete" required />
      </div>
      <label className="flex h-8 items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
        Required
      </label>
      <Button type="submit" disabled={isPending}>{isPending ? "Adding..." : "Add step"}</Button>
    </form>
  )
}

export function AddTerritoryForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startTransition(async () => {
      try {
        await createTerritory({ name, code })
        setName("")
        setCode("")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add territory")
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-end">
      <div className="flex flex-col gap-2">
        <Label htmlFor="territory-name">Territory name</Label>
        <Input id="territory-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Central Malaysia" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="territory-code">Code</Label>
        <Input id="territory-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="MY-CENTRAL" required />
      </div>
      <Button type="submit" disabled={isPending}>{isPending ? "Adding..." : "Add territory"}</Button>
    </form>
  )
}

export function AddCommissionRuleForm() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [productTag, setProductTag] = useState("")
  const [currency, setCurrency] = useState("MYR")
  const [basisPoints, setBasisPoints] = useState("1000")
  const [holdDays, setHoldDays] = useState("30")

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startTransition(async () => {
      try {
        await createCommissionRule({ productTag, currency, basisPoints: Number(basisPoints), holdDays: Number(holdDays) })
        setProductTag("")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not add commission policy")
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,.6fr)_minmax(0,.8fr)_minmax(0,.7fr)_auto] sm:items-end">
      <div className="flex flex-col gap-2"><Label htmlFor="commission-product">Product tag</Label><Input id="commission-product" value={productTag} onChange={(event) => setProductTag(event.target.value)} placeholder="fleet-telematics" required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="commission-currency">Currency</Label><Input id="commission-currency" value={currency} onChange={(event) => setCurrency(event.target.value)} placeholder="MYR" maxLength={3} required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="commission-rate">Rate (bps)</Label><Input id="commission-rate" type="number" min="0" max="10000" step="1" value={basisPoints} onChange={(event) => setBasisPoints(event.target.value)} required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="commission-hold">Hold days</Label><Input id="commission-hold" type="number" min="0" step="1" value={holdDays} onChange={(event) => setHoldDays(event.target.value)} required /></div>
      <Button type="submit" disabled={isPending}>{isPending ? "Adding..." : "Add policy"}</Button>
      <p className="sm:col-span-5 text-xs text-muted-foreground">1,000 basis points = 10%. The hold period applies when your host creates a commission from this policy.</p>
    </form>
  )
}

export function LinkExistingUserForm({ agents }: { agents: Array<{ id: string; displayName: string }> }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [userId, setUserId] = useState("")
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startTransition(async () => {
      try {
        await linkExistingUserToAgent({ userId, agentId })
        setUserId("")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not link host account")
      }
    })
  }

  if (agents.length === 0) return <p className="text-sm text-muted-foreground">Create an agent profile before linking a host account.</p>

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-end">
      <div className="flex flex-col gap-2"><Label htmlFor="host-user-id">Verified host user UUID</Label><Input id="host-user-id" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="From your auth provider's server-side user record" required /></div>
      <div className="flex flex-col gap-2"><Label htmlFor="agent-profile">Agent profile</Label><select id="agent-profile" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}</select></div>
      <Button type="submit" disabled={isPending}>{isPending ? "Linking..." : "Link account"}</Button>
    </form>
  )
}

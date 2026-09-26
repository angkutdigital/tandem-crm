"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createOnboardingStep, createTerritory } from "@/lib/actions"

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

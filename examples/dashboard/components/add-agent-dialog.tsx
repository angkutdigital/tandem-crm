"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createAgentProfile } from "@/lib/actions"

const EMPTY_FORM = { displayName: "", externalRef: "" }

export function AddAgentDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      const agentId = await createAgentProfile(form)
      setOpen(false)
      setForm(EMPTY_FORM)
      router.push(`/agents/${agentId}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add agent")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Add agent</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add agent</DialogTitle>
          <DialogDescription>
            Create the operational profile first. Link a real sign-in account separately through your host auth provider when this person needs dashboard access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-display-name">Name</Label>
            <Input
              id="agent-display-name"
              value={form.displayName}
              onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-external-ref">External reference <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="agent-external-ref"
              value={form.externalRef}
              onChange={(event) => setForm((current) => ({ ...current, externalRef: event.target.value }))}
              placeholder="e.g. payroll or partner ID"
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>{pending ? "Adding..." : "Add agent"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

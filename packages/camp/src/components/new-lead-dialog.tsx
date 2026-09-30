"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "./ui/button.js"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js"
import { Input } from "./ui/input.js"
import { Label } from "./ui/label.js"
import { createLead } from "../actions.js"

const EMPTY_FORM = {
  companyName: "",
  contactName: "",
  contactPhone: "",
  address: "",
  qualificationMetric: "15",
  productTag: "",
}

export function NewLeadDialog({ basePath }: { basePath: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pending, setPending] = useState(false)

  function update<K extends keyof typeof EMPTY_FORM>(
    key: K,
    value: (typeof EMPTY_FORM)[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      const leadId = await createLead({
        companyName: form.companyName,
        contactName: form.contactName || undefined,
        contactPhone: form.contactPhone,
        address: form.address || undefined,
        qualificationMetric: Number(form.qualificationMetric),
        productTag: form.productTag,
      })
      setOpen(false)
      setForm(EMPTY_FORM)
      router.push(`${basePath}/${leadId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create lead")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>New lead</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
          <DialogDescription>
            The qualification metric is one number that says how big this lead
            is, such as vehicles or seats. At or below your limit (15 by
            default) the lead is set up automatically. Above it, a person
            reviews it first.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="companyName">Company name</Label>
            <Input
              id="companyName"
              value={form.companyName}
              onChange={(e) => update("companyName", e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="contactName">Person in charge (optional)</Label>
            <Input
              id="contactName"
              value={form.contactName}
              onChange={(e) => update("contactName", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="contactPhone">Contact phone</Label>
            <Input
              id="contactPhone"
              value={form.contactPhone}
              onChange={(e) => update("contactPhone", e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="address">Address (optional)</Label>
            <Input
              id="address"
              value={form.address}
              onChange={(e) => update("address", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="qualificationMetric">Qualification metric</Label>
            <Input
              id="qualificationMetric"
              type="number"
              value={form.qualificationMetric}
              onChange={(e) => update("qualificationMetric", e.target.value)}
              min={0}
              step={1}
              required
            />
            <p className="text-xs text-muted-foreground">
              A whole number, 0 or more. Use 0 to skip manual review.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="productTag">Product tag</Label>
            <Input
              id="productTag"
              value={form.productTag}
              onChange={(e) => update("productTag", e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

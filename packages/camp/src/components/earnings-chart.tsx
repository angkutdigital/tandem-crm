"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

function formatCurrency(amountMinor: number, currency: string | null) {
  if (!currency) return "—";
  return new Intl.NumberFormat("en-MY", { style: "currency", currency }).format(amountMinor / 100);
}

/** Recharts renders via hooks/context, so it needs a Client Component
 * boundary -- it cannot be imported directly into an async Server
 * Component view (that fails at runtime, not at typecheck/build). */
export function EarningsChart({ data, currency }: { data: Array<{ month: string; commissions: number }>; currency: string | null }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 12, right: 12 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={10} />
          <YAxis hide />
          <Tooltip formatter={(value) => formatCurrency(Number(value) * 100, currency)} />
          <Bar dataKey="commissions" fill="var(--color-chart-1, #2563eb)" radius={5} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

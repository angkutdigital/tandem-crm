"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Download } from "lucide-react";
import { type ColumnDef, type PaginationState, type SortingState, useTable } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { DataGrid, DataGridContainer, dataGridFeatures, type DataGridFeatures } from "@/components/reui/data-grid/data-grid";
import { DataGridPagination } from "@/components/reui/data-grid/data-grid-pagination";
import { DataGridScrollArea } from "@/components/reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "@/components/reui/data-grid/data-grid-table";

type EarningsRow = {
  id: string;
  companyName: string;
  amountMinor: number;
  currency: string;
  paidAt: string;
};

type MonthlyMetric = {
  month: string;
  commissionsClosedCount: number;
  commissionsClosedMinor: number;
  leadsCreatedCount: number;
};

const chartConfig = {
  commissions: { label: "Paid commissions", color: "var(--chart-1)" },
} satisfies ChartConfig;

function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat("en-MY", { style: "currency", currency }).format(amountMinor / 100);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "numeric" });
}

function escapeCsv(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function EarningsDashboard({
  rows,
  monthlyMetrics,
}: {
  rows: EarningsRow[];
  monthlyMetrics: MonthlyMetric[];
}) {
  const [query, setQuery] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [sorting, setSorting] = useState<SortingState>([{ id: "paidAt", desc: true }]);

  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => row.companyName.toLowerCase().includes(normalized));
  }, [query, rows]);

  const columns = useMemo<ColumnDef<DataGridFeatures, EarningsRow>[]>(
    () => [
      {
        accessorKey: "companyName",
        header: "Company",
        cell: (info) => <span className="font-medium">{info.getValue() as string}</span>,
        size: 280,
      },
      {
        accessorKey: "amountMinor",
        header: "Paid commission",
        cell: ({ row }) => formatCurrency(row.original.amountMinor, row.original.currency),
        size: 180,
        meta: { headerClassName: "text-right", cellClassName: "text-right tabular-nums" },
      },
      {
        accessorKey: "paidAt",
        header: "Paid on",
        cell: (info) => formatDate(info.getValue() as string),
        size: 180,
      },
    ],
    [],
  );

  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: visibleRows,
    pageCount: Math.ceil(visibleRows.length / pagination.pageSize),
    getRowId: (row) => row.id,
    state: { pagination, sorting },
    onPaginationChange: setPagination,
    onSortingChange: setSorting,
  });

  const chartData = monthlyMetrics.map((metric) => ({
    month: new Date(`${metric.month}-01T00:00:00`).toLocaleDateString("en-MY", { month: "short" }),
    commissions: metric.commissionsClosedMinor / 100,
  }));

  function downloadCsv() {
    const content = [
      ["Company", "Paid commission", "Currency", "Paid on"],
      ...visibleRows.map((row) => [row.companyName, (row.amountMinor / 100).toFixed(2), row.currency, row.paidAt]),
    ].map((line) => line.map(escapeCsv).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tandem-earnings.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Paid commissions</CardTitle>
          <CardDescription>Commission income closed each month. Held or eligible payouts are not included.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart accessibilityLayer data={chartData} margin={{ left: 12, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={10} />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent formatter={(value) => formatCurrency(Number(value) * 100, rows[0]?.currency ?? "MYR")} />}
              />
              <Bar dataKey="commissions" fill="var(--color-commissions)" radius={5} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-4 sm:flex sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Earnings history</CardTitle>
            <CardDescription>Paid commission records only.</CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Search paid commissions"
              className="sm:w-56"
              onChange={(event) => {
                setQuery(event.target.value);
                setPagination((current) => ({ ...current, pageIndex: 0 }));
              }}
              placeholder="Search company"
              value={query}
            />
            <Button variant="outline" onClick={downloadCsv} disabled={visibleRows.length === 0}>
              <Download aria-hidden="true" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {visibleRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No paid commissions match this view.</p>
          ) : (
            <DataGrid table={table} recordCount={visibleRows.length}>
              <div className="w-full space-y-2.5">
                <DataGridContainer>
                  <DataGridScrollArea>
                    <DataGridTable />
                  </DataGridScrollArea>
                </DataGridContainer>
                <DataGridPagination />
              </div>
            </DataGrid>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

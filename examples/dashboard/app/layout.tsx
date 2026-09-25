import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tandem Dashboard",
  description: "Partner commissions, onboarding, and payouts for a Tandem workspace.",
};

// Every page reads the demo-session cookie to resolve the current member,
// so there is no static shell to prerender; this dashboard is dynamic by
// nature (same as any app whose pages are scoped to a signed-in identity).
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-svh overflow-hidden">
        <TooltipProvider delay={300}>
          <SidebarProvider className="h-svh overflow-hidden">
            <AppSidebar />
            <SidebarInset className="overflow-y-auto">{children}</SidebarInset>
          </SidebarProvider>
          <Toaster position="bottom-right" closeButton />
        </TooltipProvider>
      </body>
    </html>
  );
}

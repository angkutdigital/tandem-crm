import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// Same two families as tandem-site's landing page, so the marketing site,
// docs, and this dashboard all read as one product.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Camp",
  description: "Partner commissions, onboarding, disputes, and payouts for a Tandem workspace.",
};

// Every page reads the demo-session cookie to resolve the current member,
// so there is no static shell to prerender; this dashboard is dynamic by
// nature (same as any app whose pages are scoped to a signed-in identity).
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${ibmPlexMono.variable} h-full antialiased`}
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

import Link from "next/link";
import Image from "next/image";

import { NavLinks } from "@/components/nav-links";
import { UserSwitcher } from "@/components/user-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { currentMember } from "@/lib/queries";
import { isDemoAuth } from "@/lib/auth";

export async function AppSidebar() {
  const member = await currentMember();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Image src="/logo-mark.svg" alt="" width={16} height={16} className="invert" />
              </div>
              <div className="grid flex-1 leading-tight">
                <span className="truncate text-sm font-semibold tracking-tight">
                  Camp
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  by TandemCRM
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavLinks role={member?.role ?? "agent"} />
      </SidebarContent>

      <SidebarFooter>
        <UserSwitcher currentMember={member} demoMode={isDemoAuth} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

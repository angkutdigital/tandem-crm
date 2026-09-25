import Link from "next/link";
import { Zap } from "lucide-react";

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

export async function AppSidebar() {
  const member = await currentMember();

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="size-4" strokeWidth={2.5} />
              </div>
              <div className="grid flex-1 leading-tight">
                <span className="truncate text-sm font-semibold tracking-tight">
                  Tandem
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  Commission engine
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavLinks />
      </SidebarContent>

      <SidebarFooter>
        <UserSwitcher currentMember={member} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
